(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_LOD_HANDOFF_V22__) return;
  window.__ZWX_MRALA_LOD_HANDOFF_V22__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Start preparing native detail before the core LOD switch, then keep a
  // wide hysteresis band so small zoom changes do not bounce between qualities.
  const PREWARM_START_ZOOM = 5.15;
  const NATIVE_ENTER_ZOOM = 5.50;
  const OVERVIEW_REENTER_ZOOM = 4.85;
  const PREWARM_FRAMES = 3;
  const CHUNK_VIEWPORT_PAD = 0.12;
  const FETCH_CONCURRENCY = 6;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxLodHandoffV22Installed) return;
  mapPrototype.__zwxLodHandoffV22Installed = true;

  let manifest = null;
  let overviewLayer = null;
  let nativeLayer = null;
  let map = null;
  let timer = 0;
  let generation = 0;
  let busy = false;
  let lastSignature = "";
  const inflight = new Map();

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function frames() {
    const all = Array.isArray(manifest?.frames) ? manifest.frames : [];
    const unavailable = window.__ZWX_MRALA_UNAVAILABLE_FRAME_IDS__ || new Set();
    const valid = all
      .filter(frame =>
        frame?.id &&
        frame?.nativeChunksReady &&
        !unavailable.has(String(frame.id)) &&
        Number.isFinite(frameMs(frame))
      )
      .sort((a, b) => frameMs(a) - frameMs(b));

    if (!valid.length) return [];
    const newest = frameMs(valid[valid.length - 1]);
    const cutoff = newest - 3 * 60 * 60 * 1000;
    return valid.filter(frame => frameMs(frame) >= cutoff);
  }

  function chunkLayout() {
    return Array.isArray(manifest?.nativeChunking?.layout)
      ? manifest.nativeChunking.layout
      : [];
  }

  function visibleChunks() {
    if (!map || !manifest) return [];
    const bounds = map.getBounds?.();
    if (!bounds) return [];

    let west = bounds.getWest();
    let east = bounds.getEast();
    let south = bounds.getSouth();
    let north = bounds.getNorth();

    const lonPad = Math.max(0.02, Math.abs(east - west) * CHUNK_VIEWPORT_PAD);
    const latPad = Math.max(0.02, Math.abs(north - south) * CHUNK_VIEWPORT_PAD);
    west -= lonPad;
    east += lonPad;
    south -= latPad;
    north += latPad;

    return chunkLayout().filter(chunk => {
      const b = (chunk?.bounds || []).map(Number);
      if (b.length !== 4 || b.some(value => !Number.isFinite(value))) return false;
      const [cw, cs, ce, cn] = b;
      return ce >= west && cw <= east && cn >= south && cs <= north;
    });
  }

  function overviewFrameId() {
    const key = String(overviewLayer?.activeKey || "");
    return key.startsWith("overview:") ? key.slice("overview:".length) : "";
  }

  function anchorIndex(list) {
    const activeId = overviewFrameId();
    if (activeId) {
      const index = list.findIndex(frame => String(frame.id) === activeId);
      if (index >= 0) return index;
    }

    const slider = Math.round(Number(document.getElementById("frameSlider")?.value));
    if (Number.isFinite(slider)) {
      return Math.max(0, Math.min(list.length - 1, slider));
    }
    return Math.max(0, list.length - 1);
  }

  function prewarmFrames(list) {
    if (!list.length) return [];
    const anchor = anchorIndex(list);
    const result = [];
    const seen = new Set();
    let index = anchor;
    while (result.length < Math.min(PREWARM_FRAMES, list.length) && !seen.has(index)) {
      seen.add(index);
      result.push(list[index]);
      index = (index + 1) % list.length;
    }
    return result;
  }

  function textureKey(frameId, chunkId) {
    return `${frameId}:${chunkId}`;
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(
      manifest?.nativeChunking?.template || "native-chunks/{frameId}/{chunkId}.dbz"
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

  async function fetchRaw(frame, chunk) {
    const url = chunkUrl(frame.id, chunk.id);
    if (inflight.has(url)) return inflight.get(url);

    const promise = (async () => {
      const response = await window.fetch(url, {
        cache: "force-cache",
        priority: "low"
      });
      if (!response.ok) throw new Error(`Native LOD prewarm HTTP ${response.status}`);

      const expected =
        Math.max(1, Number(chunk?.width) || 1) *
        Math.max(1, Number(chunk?.height) || 1);
      const raw = await unpack(await response.arrayBuffer(), expected);
      if (raw.byteLength !== expected) {
        throw new Error(`Native LOD prewarm ${chunk.id} size ${raw.byteLength} != ${expected}`);
      }
      return raw;
    })();

    inflight.set(url, promise);
    try {
      return await promise;
    } finally {
      if (inflight.get(url) === promise) inflight.delete(url);
    }
  }

  function reserveKeys(list, chunks) {
    if (!nativeLayer) return;
    const reserve = new Set(nativeLayer.__zwxLodPrewarmKeys || []);
    for (const frame of list) {
      for (const chunk of chunks) reserve.add(textureKey(frame.id, chunk.id));
    }
    nativeLayer.__zwxLodPrewarmKeys = reserve;
  }

  async function prewarm() {
    if (MOBILE || busy || !manifest || !nativeLayer || !map) return;
    const zoom = Number(map.getZoom?.());
    if (!Number.isFinite(zoom) || zoom < PREWARM_START_ZOOM || zoom >= NATIVE_ENTER_ZOOM) return;

    const list = frames();
    const chunks = visibleChunks();
    const wantedFrames = prewarmFrames(list);
    if (!wantedFrames.length || !chunks.length) return;

    const signature = `${zoom.toFixed(2)}:${chunks.map(c => c.id).sort().join("|")}:${wantedFrames.map(f => f.id).join("|")}`;
    if (signature === lastSignature) return;
    lastSignature = signature;

    const localGeneration = generation;
    const ids = chunks.map(chunk => String(chunk.id));
    nativeLayer.setVisible?.(ids);
    reserveKeys(wantedFrames, chunks);

    const tasks = [];
    for (const frame of wantedFrames) {
      for (const chunk of chunks) {
        const key = textureKey(frame.id, chunk.id);
        if (!nativeLayer.textures?.has(key)) tasks.push({ frame, chunk, key });
      }
    }
    if (!tasks.length) return;

    busy = true;
    let cursor = 0;
    let loaded = 0;

    async function worker() {
      while (cursor < tasks.length) {
        if (localGeneration !== generation) return;
        const task = tasks[cursor++];
        try {
          const raw = await fetchRaw(task.frame, task.chunk);
          if (localGeneration !== generation) return;
          nativeLayer.addTexture?.(task.frame.id, task.chunk, raw);
          if (nativeLayer.textures?.has(task.key)) loaded += 1;
        } catch (error) {
          console.warn("MRALA v22 native prewarm chunk failed", error);
        }
      }
    }

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(FETCH_CONCURRENCY, Math.max(1, tasks.length)) },
          () => worker()
        )
      );
      nativeLayer.map?.triggerRepaint?.();
      console.info(
        "MRALA v22 LOD prewarm:",
        `${wantedFrames.length} native frame(s) staged`,
        `• ${chunks.length} chunks/frame`,
        `• ${loaded} new texture(s)`,
        `• z${zoom.toFixed(2)}`
      );
    } finally {
      busy = false;
    }
  }

  function schedule(delay = 90) {
    if (MOBILE || !map) return;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      prewarm().catch(error => console.warn("MRALA v22 LOD prewarm failed", error));
    }, delay);
  }

  // Re-write the LOD recommendations after mapbox-token.js applies its defaults.
  // The lower exit threshold creates a wide hysteresis band and eliminates
  // rapid overview/native toggling around one zoom level.
  const previousFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const response = await previousFetch(input, init);
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (!response.ok || !MANIFEST_RE.test(url)) return response;

    try {
      const next = await response.clone().json();
      if (next?.lod?.overview) next.lod.overview.recommendedMaxZoom = NATIVE_ENTER_ZOOM;
      if (next?.lod?.native) next.lod.native.recommendedMinZoom = OVERVIEW_REENTER_ZOOM;
      manifest = next;

      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("etag");

      schedule(0);
      return new Response(JSON.stringify(next), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch (error) {
      console.warn("MRALA v22 manifest handoff patch failed", error);
      return response;
    }
  };

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID) {
      overviewLayer = layer;
      map = layer.map || map;
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxLodHandoffV22Patched) {
      layer.__zwxLodHandoffV22Patched = true;
      nativeLayer = layer;
      map = layer.map || map;
      layer.__zwxLodPrewarmKeys = new Set();

      const originalEvictExcept = layer.evictExcept;
      if (typeof originalEvictExcept === "function") {
        layer.evictExcept = function(keep) {
          const combined = new Set(keep || []);
          for (const key of this.__zwxLodPrewarmKeys || []) combined.add(key);
          return originalEvictExcept.call(this, combined);
        };
      }

      map?.on?.("zoom", () => schedule(110));
      map?.on?.("zoomend", () => schedule(0));
      map?.on?.("moveend", () => {
        generation += 1;
        lastSignature = "";
        schedule(0);
      });
    }

    return result;
  };

  window.__ZWX_MRALA_LOD_HANDOFF_STATE__ = () => ({
    mobile: MOBILE,
    zoom: Number(map?.getZoom?.() || 0),
    prewarmStart: PREWARM_START_ZOOM,
    nativeEnter: NATIVE_ENTER_ZOOM,
    overviewReenter: OVERVIEW_REENTER_ZOOM,
    nativeEnabled: Boolean(nativeLayer?.enabled),
    stagedTextures: Number(nativeLayer?.__zwxLodPrewarmKeys?.size || 0)
  });

  console.info(
    "MRALA v22: native prewarms before LOD entry • native enters z5.50 • overview does not return until z4.85"
  );
})();