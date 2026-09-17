(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_BANDWIDTH_V15__) return;
  window.__ZWX_MRALA_BANDWIDTH_V15__ = true;

  // Tell the core page that one external owner is responsible for native
  // temporal buffering. This prevents its legacy 10-frame native prefetch
  // from running alongside this queue.
  window.__ZWX_MRALA_V14_READY_QUEUE__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Small, speed-aware runway. The queue grows only while playback is active.
  // Idle native view keeps just a couple of observations warm.
  const IDLE_DEPTH = MOBILE ? 1 : 2;
  const PLAY_GATE = MOBILE ? 2 : 3;
  const LOAD_CONCURRENCY = MOBILE ? 2 : 3;
  const GPU_BUDGET_BYTES = (MOBILE ? 72 : 144) * 1048576;
  const ACTIVE_RETRY_MS = MOBILE ? 70 : 40;
  const IDLE_RETRY_MS = MOBILE ? 160 : 110;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxBandwidthV15Installed) return;
  mapPrototype.__zwxBandwidthV15Installed = true;

  let runtimeManifest = null;
  let nativeLayer = null;
  let timer = 0;
  let busy = false;
  let pending = false;
  let bypassPlayGate = false;
  let generation = 0;
  let lastSignature = "";

  const inflight = new Map();
  const originalFetch = window.fetch.bind(window);

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function timelineFrames() {
    const frames = Array.isArray(runtimeManifest?.frames)
      ? runtimeManifest.frames
      : [];

    const valid = frames
      .filter(frame => frame?.id && Number.isFinite(frameMs(frame)))
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
      (runtimeManifest?.nativeChunking?.layout || []).map(chunk => [
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

  function chunkKey(frameId, chunkId) {
    return `${frameId}:${chunkId}`;
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(
      runtimeManifest?.nativeChunking?.template ||
      "native-chunks/{frameId}/{chunkId}.dbz"
    )
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));

    return new URL(template, BASE).toString();
  }

  function isPlaying() {
    return /Pause/i.test(
      String(document.getElementById("playPause")?.textContent || "")
    );
  }

  function speedLabel() {
    return String(
      document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent ||
      "1×"
    ).trim();
  }

  function speedDepth() {
    const label = speedLabel();
    if (label === "2×") return MOBILE ? 4 : 6;
    if (label === "1.5×") return MOBILE ? 3 : 5;
    if (label === "1×") return MOBILE ? 3 : 4;
    return MOBILE ? 2 : 3;
  }

  function sliderIndex(frames = timelineFrames()) {
    if (!frames.length) return -1;
    const value = Math.round(
      Number(document.getElementById("frameSlider")?.value)
    );
    if (!Number.isFinite(value)) return frames.length - 1;
    return Math.max(0, Math.min(frames.length - 1, value));
  }

  function frameBytes(chunks) {
    return chunks.reduce(
      (sum, chunk) =>
        sum +
        Math.max(1, Number(chunk?.width) || 1) *
          Math.max(1, Number(chunk?.height) || 1),
      0
    );
  }

  function queueDepth(ids, playing = isPlaying()) {
    const chunks = chunksFor(ids);
    const bytes = Math.max(1, frameBytes(chunks));
    const budgetDepth = Math.max(
      PLAY_GATE,
      Math.floor(GPU_BUDGET_BYTES / bytes)
    );
    const desired = playing ? speedDepth() : IDLE_DEPTH;
    return Math.max(1, Math.min(desired, budgetDepth));
  }

  function upcomingFrames(count, anchor = sliderIndex()) {
    const frames = timelineFrames();
    if (!frames.length || anchor < 0) return [];

    const output = [];
    const seen = new Set();
    let index = Math.max(0, Math.min(frames.length - 1, anchor));

    while (output.length < Math.min(count, Math.max(0, frames.length - 1))) {
      index = (index + 1) % frames.length;
      if (seen.has(index)) break;
      seen.add(index);
      const frame = frames[index];
      if (frame?.nativeChunksReady) output.push(frame);
    }

    return output;
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

  async function fetchChunkBytes(url) {
    if (inflight.has(url)) return inflight.get(url);

    const promise = (async () => {
      const response = await originalFetch(url, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Native chunk HTTP ${response.status}`);
      }
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
    const key = chunkKey(frame.id, chunk.id);
    if (layer.textures?.has(key)) return true;

    const packed = await fetchChunkBytes(chunkUrl(frame.id, chunk.id));
    const expected =
      Math.max(1, Number(chunk?.width) || 1) *
      Math.max(1, Number(chunk?.height) || 1);
    const raw = await unpack(packed, expected);

    if (raw.byteLength !== expected) {
      throw new Error(
        `Native chunk ${chunk.id} size ${raw.byteLength} != ${expected}`
      );
    }

    layer.addTexture(frame.id, chunk, raw);
    return layer.textures?.has(key) === true;
  }

  function frameComplete(layer, frame, chunks) {
    return chunks.every(chunk =>
      layer.textures?.has(chunkKey(frame.id, chunk.id))
    );
  }

  async function loadFrame(layer, frame, chunks) {
    const targets = chunks.filter(
      chunk => !layer.textures?.has(chunkKey(frame.id, chunk.id))
    );

    let cursor = 0;
    let loaded = 0;

    async function worker() {
      while (cursor < targets.length) {
        const chunk = targets[cursor++];
        try {
          if (await ensureTexture(layer, frame, chunk)) loaded += 1;
        } catch (error) {
          console.warn(
            "MRALA v15 native chunk failed",
            frame?.id,
            chunk?.id,
            error
          );
        }
      }
    }

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            LOAD_CONCURRENCY,
            Math.max(1, targets.length)
          )
        },
        () => worker()
      )
    );

    return loaded;
  }

  function currentPins(layer, chunks) {
    const pins = new Set();
    for (const frameId of [layer?.fromFrame, layer?.toFrame]) {
      if (!frameId) continue;
      for (const chunk of chunks) {
        pins.add(chunkKey(frameId, chunk.id));
      }
    }
    return pins;
  }

  function readyAhead(layer = nativeLayer, limit = null) {
    if (!layer?.enabled) return 0;
    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!chunks.length) return 0;

    const depth = Math.max(
      1,
      Number(limit) || queueDepth(ids, true)
    );
    const frames = upcomingFrames(depth);
    let ready = 0;

    for (const frame of frames) {
      if (!frameComplete(layer, frame, chunks)) break;
      ready += 1;
    }

    return ready;
  }

  async function fillQueue({ gateOnly = false } = {}) {
    const layer = nativeLayer;
    if (!layer?.enabled || !runtimeManifest) {
      return { ready: 0, target: 0 };
    }

    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!ids.length || !chunks.length) {
      return { ready: 0, target: 0 };
    }

    const desired = gateOnly
      ? PLAY_GATE
      : queueDepth(ids, isPlaying());
    const frames = upcomingFrames(desired);
    if (!frames.length) {
      return { ready: 0, target: 0 };
    }

    const localGeneration = generation;
    let uploaded = 0;

    // Prioritize complete observations in timeline order. A later frame never
    // consumes network slots before an earlier frame has had its chance.
    for (const frame of frames) {
      if (localGeneration !== generation || !layer.enabled) break;
      if (!frameComplete(layer, frame, chunks)) {
        uploaded += await loadFrame(layer, frame, chunks);
      }
      if (gateOnly && readyAhead(layer, PLAY_GATE) >= PLAY_GATE) break;
    }

    if (localGeneration !== generation || !layer.enabled) {
      return { ready: 0, target: desired };
    }

    const liveFrames = upcomingFrames(desired);
    const keep = currentPins(layer, chunks);
    for (const frame of liveFrames) {
      for (const chunk of chunks) {
        keep.add(chunkKey(frame.id, chunk.id));
      }
    }

    layer.evictExcept?.(keep);
    layer.map?.triggerRepaint?.();

    const ready = readyAhead(layer, desired);
    const signature = `${sliderIndex()}:${ids.join("|")}:${ready}:${desired}:${isPlaying()}`;

    if (signature !== lastSignature || uploaded) {
      lastSignature = signature;
      console.info(
        "MRALA v15 bandwidth queue:",
        `${ready}/${desired} native frames ahead`,
        `• ${ids.length} chunks/frame`,
        `• ${uploaded} new texture(s)`,
        isPlaying() ? `• ${speedLabel()}` : "• idle"
      );
    }

    return { ready, target: desired };
  }

  function schedule(delay = 0) {
    if (!nativeLayer?.enabled) return;
    pending = true;
    if (busy || timer) return;

    timer = window.setTimeout(async () => {
      timer = 0;
      if (busy || !nativeLayer?.enabled) return;

      busy = true;
      try {
        do {
          pending = false;
          const result = await fillQueue();
          if (result.ready < result.target && nativeLayer?.enabled) {
            pending = true;
            if (isPlaying()) break;
          }
        } while (pending);
      } finally {
        busy = false;
        if (pending) {
          schedule(isPlaying() ? ACTIVE_RETRY_MS : IDLE_RETRY_MS);
        }
      }
    }, Math.max(0, delay));
  }

  async function primeForPlay() {
    const layer = nativeLayer;
    if (!layer?.enabled) return true;

    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!ids.length || !chunks.length) return true;

    const required = Math.min(
      PLAY_GATE,
      upcomingFrames(PLAY_GATE).length
    );
    if (!required || readyAhead(layer, required) >= required) return true;

    generation += 1;
    const deadline = performance.now() + (MOBILE ? 4200 : 3200);

    while (performance.now() < deadline) {
      if (!busy) {
        busy = true;
        try {
          await fillQueue({ gateOnly: true });
        } finally {
          busy = false;
        }
      }

      if (readyAhead(layer, required) >= required) return true;
      await new Promise(resolve => window.setTimeout(resolve, 35));
    }

    return readyAhead(layer, required) >= required;
  }

  // Capture the one manifest the core page already requests. No timestamped
  // background manifest polling and no full-history download pass.
  window.fetch = async function(input, init) {
    const response = await originalFetch(input, init);
    const url = String(
      typeof input === "string" ? input : input?.url || ""
    );

    if (response.ok && MANIFEST_RE.test(url)) {
      try {
        runtimeManifest = await response.clone().json();
        window.__ZWX_MRALA_RUNTIME_MANIFEST__ = runtimeManifest;
      } catch (error) {
        console.warn("MRALA v15 manifest capture failed", error);
      }
    }

    return response;
  };

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== NATIVE_ID || layer.__zwxBandwidthV15Patched) {
      return result;
    }

    layer.__zwxBandwidthV15Patched = true;
    nativeLayer = layer;

    const originalSetVisible = layer.setVisible;
    if (typeof originalSetVisible === "function") {
      layer.setVisible = function(ids) {
        generation += 1;
        const output = originalSetVisible.call(this, ids);
        if (this.enabled) schedule(MOBILE ? 180 : 120);
        return output;
      };
    }

    const originalSetEnabled = layer.setEnabled;
    if (typeof originalSetEnabled === "function") {
      layer.setEnabled = function(enabled) {
        generation += 1;
        const output = originalSetEnabled.call(this, enabled);
        if (enabled) {
          schedule(MOBILE ? 180 : 120);
        } else {
          if (timer) window.clearTimeout(timer);
          timer = 0;
          pending = false;
        }
        return output;
      };
    }

    const originalActivateFrame = layer.activateFrame;
    if (typeof originalActivateFrame === "function") {
      layer.activateFrame = function(...activateArgs) {
        const output = originalActivateFrame.apply(this, activateArgs);
        if (output && this.enabled) schedule(0);
        return output;
      };
    }

    const originalSetBlendFrames = layer.setBlendFrames;
    if (typeof originalSetBlendFrames === "function") {
      layer.setBlendFrames = function(...blendArgs) {
        const output = originalSetBlendFrames.apply(this, blendArgs);
        if (this.enabled) schedule(0);
        return output;
      };
    }

    layer.map?.on?.("moveend", () => {
      generation += 1;
      if (layer.enabled) schedule(MOBILE ? 140 : 90);
    });

    layer.map?.on?.("zoomend", () => {
      generation += 1;
      if (layer.enabled) schedule(MOBILE ? 140 : 90);
    });

    console.info(
      "MRALA bandwidth controller v15: one native prefetch owner • no predictive warm • no full 3h cache • speed-aware rolling queue"
    );

    return result;
  };

  document.addEventListener(
    "click",
    event => {
      const button = event.target?.closest?.("#playPause");
      if (!button || bypassPlayGate || isPlaying()) return;
      if (!nativeLayer?.enabled) return;

      const ids = visibleIds(nativeLayer);
      const required = Math.min(
        PLAY_GATE,
        upcomingFrames(PLAY_GATE).length
      );
      if (!ids.length || !required || readyAhead(nativeLayer, required) >= required) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = "Preparing…";

      primeForPlay()
        .catch(() => false)
        .then(ready => {
          button.disabled = false;
          button.textContent = originalText;

          if (!ready) {
            schedule(0);
            return;
          }

          bypassPlayGate = true;
          button.click();
          bypassPlayGate = false;
        });
    },
    true
  );

  window.addEventListener("DOMContentLoaded", () => {
    const speed = document.getElementById("speedSelect");
    speed?.addEventListener("change", () => {
      generation += 1;
      schedule(0);
    });
  }, { once: true });
})();
