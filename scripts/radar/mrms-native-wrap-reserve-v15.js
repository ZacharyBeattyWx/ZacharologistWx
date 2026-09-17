(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_WRAP_RESERVE_V15__) return;
  window.__ZWX_MRALA_WRAP_RESERVE_V15__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Keep only the first few native observations of the loop resident while
  // playback is active. This is a tiny wrap reserve, not another runway: it
  // prevents the end-of-loop pause from waiting on fresh CloudFront transfers.
  const RESERVE_DEPTH = MOBILE ? 2 : 3;
  const LOAD_CONCURRENCY = MOBILE ? 1 : 2;
  const START_DELAY_MS = MOBILE ? 140 : 80;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxWrapReserveV15Installed) return;
  mapPrototype.__zwxWrapReserveV15Installed = true;

  let nativeLayer = null;
  let timer = 0;
  let busy = false;
  let pending = false;
  let generation = 0;
  let lastSignature = "";
  const inflight = new Map();

  function isPlaying() {
    return /Pause/i.test(
      String(document.getElementById("playPause")?.textContent || "")
    );
  }

  function manifest() {
    return window.__ZWX_MRALA_RUNTIME_MANIFEST__ || null;
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function timelineFrames() {
    const frames = Array.isArray(manifest()?.frames) ? manifest().frames : [];
    const valid = frames
      .filter(
        frame =>
          frame?.id &&
          frame?.nativeChunksReady &&
          Number.isFinite(frameMs(frame))
      )
      .sort((a, b) => frameMs(a) - frameMs(b));

    if (!valid.length) return [];
    const newest = frameMs(valid[valid.length - 1]);
    const cutoff = newest - 3 * 60 * 60 * 1000;
    return valid.filter(frame => frameMs(frame) >= cutoff);
  }

  function normalizeIds(ids) {
    return [...new Set((ids || []).map(String))].sort();
  }

  function visibleIds(layer = nativeLayer) {
    return normalizeIds(layer?.visibleIds || []);
  }

  function chunkMap() {
    return new Map(
      (manifest()?.nativeChunking?.layout || []).map(chunk => [
        String(chunk.id),
        chunk
      ])
    );
  }

  function chunksFor(ids) {
    const byId = chunkMap();
    return normalizeIds(ids)
      .map(id => byId.get(id))
      .filter(Boolean);
  }

  function textureKey(frameId, chunkId) {
    return `${frameId}:${chunkId}`;
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(
      manifest()?.nativeChunking?.template ||
      "native-chunks/{frameId}/{chunkId}.dbz"
    )
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));

    return new URL(template, BASE).toString();
  }

  async function unpack(buffer, expected) {
    if (buffer.byteLength === expected) return new Uint8Array(buffer);
    const probe = new Uint8Array(buffer);

    if (
      probe[0] === 0x1f &&
      probe[1] === 0x8b &&
      typeof DecompressionStream !== "undefined"
    ) {
      const stream = new Blob([buffer])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    return probe;
  }

  async function fetchBytes(url) {
    if (inflight.has(url)) return inflight.get(url);

    const promise = (async () => {
      const response = await window.fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`Wrap reserve HTTP ${response.status}`);
      return response.arrayBuffer();
    })();

    inflight.set(url, promise);
    try {
      return await promise;
    } finally {
      if (inflight.get(url) === promise) inflight.delete(url);
    }
  }

  async function ensureTexture(layer, frame, chunk) {
    const key = textureKey(frame.id, chunk.id);
    if (layer.textures?.has(key)) return false;

    const packed = await fetchBytes(chunkUrl(frame.id, chunk.id));
    const expected =
      Math.max(1, Number(chunk?.width) || 1) *
      Math.max(1, Number(chunk?.height) || 1);
    const raw = await unpack(packed, expected);
    if (raw.byteLength !== expected) return false;

    layer.addTexture(frame.id, chunk, raw);
    return layer.textures?.has(key) === true;
  }

  async function warmReserve() {
    const layer = nativeLayer;
    if (!layer?.enabled || !isPlaying()) return;

    const frames = timelineFrames().slice(0, RESERVE_DEPTH);
    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!frames.length || !chunks.length) return;

    const localGeneration = generation;
    const nextKeys = new Set();
    const targets = [];

    for (const frame of frames) {
      for (const chunk of chunks) {
        const key = textureKey(frame.id, chunk.id);
        nextKeys.add(key);
        if (!layer.textures?.has(key)) targets.push({ frame, chunk });
      }
    }

    // Protect both old and new reserve keys while the viewport handoff loads.
    layer.__zwxWrapReserveKeys = new Set([
      ...(layer.__zwxWrapReserveKeys || []),
      ...nextKeys
    ]);

    let cursor = 0;
    let loaded = 0;

    async function worker() {
      while (cursor < targets.length) {
        if (localGeneration !== generation || !layer.enabled || !isPlaying()) return;
        const target = targets[cursor++];
        try {
          if (await ensureTexture(layer, target.frame, target.chunk)) loaded += 1;
        } catch (_) {}
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) },
        () => worker()
      )
    );

    if (localGeneration !== generation || !layer.enabled || !isPlaying()) return;

    layer.__zwxWrapReserveKeys = nextKeys;
    layer.map?.triggerRepaint?.();

    const complete = frames.filter(frame =>
      chunks.every(chunk =>
        layer.textures?.has(textureKey(frame.id, chunk.id))
      )
    ).length;

    const signature = `${ids.join("|")}:${complete}:${frames.length}`;
    if (signature !== lastSignature || loaded) {
      lastSignature = signature;
      console.info(
        "MRALA v15 wrap reserve:",
        `${complete}/${frames.length} loop-start frames ready`,
        `• ${ids.length} chunks/frame`,
        `• ${loaded} new texture(s)`
      );
    }
  }

  function schedule(delay = START_DELAY_MS) {
    if (!nativeLayer?.enabled || !isPlaying()) return;
    pending = true;
    if (busy || timer) return;

    timer = window.setTimeout(async () => {
      timer = 0;
      if (busy || !nativeLayer?.enabled || !isPlaying()) return;
      busy = true;
      try {
        do {
          pending = false;
          await warmReserve();
        } while (pending && nativeLayer?.enabled && isPlaying());
      } finally {
        busy = false;
        if (pending && nativeLayer?.enabled && isPlaying()) schedule(120);
      }
    }, Math.max(0, delay));
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== NATIVE_ID || layer.__zwxWrapReserveV15Patched) return result;

    layer.__zwxWrapReserveV15Patched = true;
    layer.__zwxWrapReserveKeys = new Set();
    nativeLayer = layer;

    const originalEvictExcept = layer.evictExcept;
    if (typeof originalEvictExcept === "function") {
      layer.evictExcept = function(keep) {
        const combined = new Set(keep || []);
        for (const key of this.__zwxWrapReserveKeys || []) combined.add(key);
        return originalEvictExcept.call(this, combined);
      };
    }

    const originalSetVisible = layer.setVisible;
    if (typeof originalSetVisible === "function") {
      layer.setVisible = function(...setArgs) {
        generation += 1;
        const output = originalSetVisible.apply(this, setArgs);
        if (this.enabled && isPlaying()) schedule();
        return output;
      };
    }

    const originalSetEnabled = layer.setEnabled;
    if (typeof originalSetEnabled === "function") {
      layer.setEnabled = function(enabled) {
        generation += 1;
        const output = originalSetEnabled.call(this, enabled);
        if (enabled && isPlaying()) schedule();
        if (!enabled) this.__zwxWrapReserveKeys = new Set();
        return output;
      };
    }

    const originalActivateFrame = layer.activateFrame;
    if (typeof originalActivateFrame === "function") {
      layer.activateFrame = function(...activateArgs) {
        const output = originalActivateFrame.apply(this, activateArgs);
        if (output && this.enabled && isPlaying()) schedule(0);
        return output;
      };
    }

    console.info(
      `MRALA v15 wrap reserve: ${RESERVE_DEPTH} loop-start native frames pinned only during playback`
    );

    return result;
  };

  document.addEventListener("click", event => {
    if (!event.target?.closest?.("#playPause")) return;
    window.setTimeout(() => schedule(0), 0);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    schedule(0);
  });
})();
