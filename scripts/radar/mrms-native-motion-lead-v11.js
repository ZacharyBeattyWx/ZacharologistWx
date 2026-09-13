(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const CORE_VIEWPORT_PAD = 0.12;
  const MOBILE = matchMedia?.("(pointer: coarse)")?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const STARTUP_FRAMES = MOBILE ? 3 : 4;
  const SAMPLE_MS = MOBILE ? 320 : 220;
  const SETTLE_AHEAD_MS = MOBILE ? 900 : 700;
  const MAX_LEAD_FRAMES = MOBILE ? 14 : 28;
  const LOAD_CONCURRENCY = MOBILE ? 2 : 6;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxMotionLeadV11Installed) return;
  mapPrototype.__zwxMotionLeadV11Installed = true;

  const normalizeIds = ids => [...new Set((ids || []).map(String))].sort();
  const textureKey = (frameId, chunkId) => `${frameId}:${chunkId}`;
  const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");

  function manifest() {
    return window.__ZWX_MRALA_RUNTIME_MANIFEST__ || null;
  }

  function timelineFrames() {
    const m = manifest();
    const frames = Array.isArray(m?.frames) ? m.frames : [];
    return frames
      .filter(frame => frame?.id && frame?.nativeChunksReady && Number.isFinite(frameMs(frame)))
      .sort((a, b) => frameMs(a) - frameMs(b));
  }

  function chunkMap() {
    return new Map((manifest()?.nativeChunking?.layout || []).map(chunk => [String(chunk.id), chunk]));
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(manifest()?.nativeChunking?.template || "native-chunks/{frameId}/{chunkId}.dbz")
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));
    return new URL(template, BASE).toString();
  }

  function visibleIds(map) {
    const m = manifest();
    const layout = m?.nativeChunking?.layout;
    const bounds = map?.getBounds?.();
    if (!Array.isArray(layout) || !layout.length || !bounds) return [];

    let west = Number(bounds.getWest());
    let east = Number(bounds.getEast());
    let south = Number(bounds.getSouth());
    let north = Number(bounds.getNorth());
    const lonPad = Math.max(0.02, Math.abs(east - west) * CORE_VIEWPORT_PAD);
    const latPad = Math.max(0.02, Math.abs(north - south) * CORE_VIEWPORT_PAD);
    west -= lonPad; east += lonPad; south -= latPad; north += latPad;

    return normalizeIds(layout.filter(chunk => {
      const b = chunk?.bounds;
      if (!Array.isArray(b) || b.length < 4) return false;
      const [cw, cs, ce, cn] = b.map(Number);
      return ce >= west && cw <= east && cn >= south && cs <= north;
    }).map(chunk => String(chunk.id)));
  }

  function currentFrameIndex(layer, frames) {
    if (!frames.length) return -1;
    const from = String(layer?.fromFrame || "");
    let index = frames.findIndex(frame => String(frame.id) === from);
    if (index >= 0) return index;

    const slider = document.getElementById("frameSlider");
    const sliderIndex = Number(slider?.value);
    if (Number.isFinite(sliderIndex)) {
      return Math.max(0, Math.min(frames.length - 1, Math.round(sliderIndex)));
    }
    return frames.length - 1;
  }

  function intervalMs() {
    return Math.max(60, Number(document.getElementById("speedSelect")?.value || 170));
  }

  async function unpack(value, expected) {
    if (value.byteLength === expected) return new Uint8Array(value);
    const probe = new Uint8Array(value);
    if (probe[0] === 0x1f && probe[1] === 0x8b && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([value]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return probe;
  }

  async function ensureTexture(layer, frame, chunk, pins) {
    const key = textureKey(frame.id, chunk.id);
    pins.add(key);
    if (layer.textures?.has(key)) return true;

    const response = await window.fetch(chunkUrl(frame.id, chunk.id), { cache: "force-cache" });
    if (!response.ok) return false;
    const packed = await response.arrayBuffer();
    const expected = Number(chunk.width || 0) * Number(chunk.height || 0);
    const raw = await unpack(packed, expected);
    if (raw.byteLength !== expected) return false;
    layer.addTexture(frame.id, chunk, raw);
    return layer.textures?.has(key) === true;
  }

  async function warmExpectedSettle(layer, motionGeneration, elapsedMs) {
    if (!layer?.enabled || motionGeneration !== layer.__zwxMotionLeadGeneration) return;
    const frames = timelineFrames();
    const ids = visibleIds(layer.map);
    if (!frames.length || !ids.length) return;

    const byId = chunkMap();
    const chunks = ids.map(id => byId.get(id)).filter(Boolean);
    if (!chunks.length) return;

    const current = currentFrameIndex(layer, frames);
    if (current < 0) return;

    const lead = Math.max(
      STARTUP_FRAMES,
      Math.min(MAX_LEAD_FRAMES, Math.ceil((elapsedMs + SETTLE_AHEAD_MS) / intervalMs()))
    );
    const targetFrames = [];
    for (let offset = 0; offset < STARTUP_FRAMES; offset += 1) {
      targetFrames.push(frames[(current + lead + offset) % frames.length]);
    }

    const pins = new Set(layer.__zwxMotionLeadKeys || []);
    const targets = [];
    for (const frame of targetFrames) {
      for (const chunk of chunks) {
        if (!layer.textures?.has(textureKey(frame.id, chunk.id))) targets.push({ frame, chunk });
        else pins.add(textureKey(frame.id, chunk.id));
      }
    }

    let cursor = 0;
    let loaded = 0;
    async function worker() {
      while (cursor < targets.length) {
        if (motionGeneration !== layer.__zwxMotionLeadGeneration) return;
        const target = targets[cursor++];
        try {
          if (await ensureTexture(layer, target.frame, target.chunk, pins)) loaded += 1;
        } catch {}
      }
    }

    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) }, () => worker()));
    if (motionGeneration !== layer.__zwxMotionLeadGeneration) return;
    layer.__zwxMotionLeadKeys = pins;
    layer.map?.triggerRepaint?.();

    if (loaded) {
      console.info(
        "MRALA motion temporal lead READY:",
        STARTUP_FRAMES + " predicted settle frames",
        ids.length + " chunks/frame",
        "lead " + lead + " frame(s)",
        "• playback kept moving during camera warm"
      );
    }
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== LAYER_ID || layer.__zwxMotionLeadV11Patched) return result;

    layer.__zwxMotionLeadV11Patched = true;
    layer.__zwxMotionLeadKeys = new Set();
    layer.__zwxMotionLeadGeneration = 0;
    layer.__zwxMotionLeadStartedAt = 0;
    layer.__zwxMotionLeadTimer = 0;

    const originalEvictExcept = layer.evictExcept;
    layer.evictExcept = function (keep) {
      const combined = new Set(keep || []);
      for (const key of this.__zwxMotionLeadKeys || []) combined.add(key);
      return originalEvictExcept.call(this, combined);
    };

    const schedule = () => {
      if (!layer.enabled) return;
      if (!layer.__zwxMotionLeadStartedAt) layer.__zwxMotionLeadStartedAt = performance.now();
      if (layer.__zwxMotionLeadTimer) return;
      const generation = layer.__zwxMotionLeadGeneration;
      layer.__zwxMotionLeadTimer = setTimeout(() => {
        layer.__zwxMotionLeadTimer = 0;
        if (generation !== layer.__zwxMotionLeadGeneration || !layer.enabled) return;
        const elapsed = Math.max(0, performance.now() - layer.__zwxMotionLeadStartedAt);
        warmExpectedSettle(layer, generation, elapsed).catch(() => {});
      }, SAMPLE_MS);
    };

    const start = () => {
      layer.__zwxMotionLeadGeneration += 1;
      layer.__zwxMotionLeadStartedAt = performance.now();
      if (layer.__zwxMotionLeadTimer) clearTimeout(layer.__zwxMotionLeadTimer);
      layer.__zwxMotionLeadTimer = 0;
      schedule();
    };

    const moving = () => schedule();

    const settled = () => {
      if (layer.__zwxMotionLeadTimer) {
        clearTimeout(layer.__zwxMotionLeadTimer);
        layer.__zwxMotionLeadTimer = 0;
      }
      const generation = layer.__zwxMotionLeadGeneration;
      const elapsed = layer.__zwxMotionLeadStartedAt
        ? Math.max(0, performance.now() - layer.__zwxMotionLeadStartedAt)
        : 0;
      warmExpectedSettle(layer, generation, elapsed).catch(() => {});
      layer.__zwxMotionLeadStartedAt = 0;
      setTimeout(() => {
        if (generation !== layer.__zwxMotionLeadGeneration) return;
        layer.__zwxMotionLeadKeys = new Set();
      }, 2600);
    };

    layer.map?.on?.("movestart", start);
    layer.map?.on?.("zoomstart", start);
    layer.map?.on?.("move", moving);
    layer.map?.on?.("moveend", settled);
    layer.map?.on?.("zoomend", settled);

    console.info(
      "MRALA archive player v11 temporal lead: camera warm follows expected playback position at settle • no extra full-history preload"
    );

    return result;
  };
})();
