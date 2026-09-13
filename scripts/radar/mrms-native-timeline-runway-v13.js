(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MOBILE = matchMedia?.("(pointer: coarse)")?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const DESIRED_RUNWAY = MOBILE ? 10 : 30;
  const GPU_BUDGET_BYTES = (MOBILE ? 176 : 384) * 1048576;
  const LOAD_CONCURRENCY = MOBILE ? 3 : 8;
  const PERIODIC_MS = MOBILE ? 180 : 85;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxTimelineRunwayV13Installed) return;
  mapPrototype.__zwxTimelineRunwayV13Installed = true;

  let nativeLayer = null;
  let busy = false;
  let pending = false;
  let timer = 0;
  let lastSignature = "";

  const normalizeIds = ids => [...new Set((ids || []).map(String))].sort();
  const textureKey = (frameId, chunkId) => `${frameId}:${chunkId}`;
  const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");

  function manifest() {
    return window.__ZWX_MRALA_RUNTIME_MANIFEST__ || null;
  }

  function timelineFrames() {
    const frames = Array.isArray(manifest()?.frames) ? manifest().frames : [];
    return frames
      .filter(frame => frame?.id && Number.isFinite(frameMs(frame)))
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

  function visibleIds(layer = nativeLayer) {
    return normalizeIds(layer?.__zwxRequestedVisibleIds || []);
  }

  function runwayCount(ids) {
    const byId = chunkMap();
    const chunks = normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
    const bytesPerFrame = chunks.reduce(
      (sum, chunk) => sum + Number(chunk?.width || 0) * Number(chunk?.height || 0),
      0
    );
    if (!bytesPerFrame) return 4;
    const budgetCount = Math.max(4, Math.floor(GPU_BUDGET_BYTES / bytesPerFrame));
    return Math.max(4, Math.min(DESIRED_RUNWAY, budgetCount));
  }

  function playbackIndex(frames) {
    if (!frames.length) return -1;
    const slider = document.getElementById("frameSlider");
    const index = Math.round(Number(slider?.value));
    if (!Number.isFinite(index)) return frames.length - 1;
    return Math.max(0, Math.min(frames.length - 1, index));
  }

  function targetFramesFromTimeline(count) {
    const frames = timelineFrames();
    if (!frames.length) return [];
    const current = playbackIndex(frames);
    if (current < 0) return [];

    const targets = [];
    for (let step = 1; step <= frames.length && targets.length < count; step += 1) {
      const frame = frames[(current + step) % frames.length];
      if (frame?.nativeChunksReady) targets.push(frame);
    }
    return targets;
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
    const expected = Number(chunk?.width || 0) * Number(chunk?.height || 0);
    const raw = await unpack(packed, expected);
    if (raw.byteLength !== expected) return false;
    layer.addTexture(frame.id, chunk, raw);
    return layer.textures?.has(key) === true;
  }

  async function fillTimelineRunway() {
    const layer = nativeLayer;
    if (!layer?.enabled || !layer.__zwxHdLocked) return;

    const ids = visibleIds(layer);
    if (!ids.length) return;

    const byId = chunkMap();
    const chunks = ids.map(id => byId.get(id)).filter(Boolean);
    if (!chunks.length) return;

    const count = runwayCount(ids);
    const frames = targetFramesFromTimeline(count);
    if (!frames.length) return;

    const previousPins = new Set(layer.__zwxV13TimelineRunwayKeys || []);
    const targetPins = new Set();
    const loadingPins = new Set(previousPins);
    const targets = [];

    for (const frame of frames) {
      for (const chunk of chunks) {
        const key = textureKey(frame.id, chunk.id);
        targetPins.add(key);
        loadingPins.add(key);
        if (!layer.textures?.has(key)) targets.push({ frame, chunk });
      }
    }

    layer.__zwxV13TimelineRunwayKeys = loadingPins;

    let cursor = 0;
    let loaded = 0;
    async function worker() {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        try {
          if (await ensureTexture(layer, target.frame, target.chunk, loadingPins)) loaded += 1;
        } catch {}
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) }, () => worker())
    );

    layer.__zwxV13TimelineRunwayKeys = targetPins;
    layer.map?.triggerRepaint?.();

    const slider = document.getElementById("frameSlider");
    const signature = `${slider?.value || "?"}:${frames[0]?.id || ""}:${count}:${ids.join("|")}`;
    if (loaded || signature !== lastSignature) {
      lastSignature = signature;
      console.info(
        "MRALA v13 timeline runway READY:",
        count + " frames ahead of actual playback slider",
        ids.length + " chunks/frame",
        loaded ? loaded + " texture(s) added from local archive/cache" : "already resident",
        "• native fromFrame no longer anchors prefetch"
      );
    }
  }

  function schedule(delay = 0) {
    if (!nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;
    pending = true;
    if (busy || timer) return;
    timer = setTimeout(async () => {
      timer = 0;
      if (busy) return;
      busy = true;
      try {
        do {
          pending = false;
          await fillTimelineRunway();
        } while (pending);
      } finally {
        busy = false;
      }
    }, Math.max(0, delay));
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== NATIVE_ID || layer.__zwxTimelineRunwayV13Patched) return result;

    layer.__zwxTimelineRunwayV13Patched = true;
    nativeLayer = layer;
    layer.__zwxV13TimelineRunwayKeys = new Set();

    const originalEvictExcept = layer.evictExcept;
    if (typeof originalEvictExcept === "function") {
      layer.evictExcept = function (keep) {
        const combined = new Set(keep || []);
        for (const key of this.__zwxV13TimelineRunwayKeys || []) combined.add(key);
        return originalEvictExcept.call(this, combined);
      };
    }

    const originalSetVisible = layer.setVisible;
    if (typeof originalSetVisible === "function") {
      layer.setVisible = function (...args) {
        const output = originalSetVisible.apply(this, args);
        schedule(0);
        return output;
      };
    }

    const originalActivateFrame = layer.activateFrame;
    if (typeof originalActivateFrame === "function") {
      layer.activateFrame = function (...args) {
        const output = originalActivateFrame.apply(this, args);
        schedule(0);
        return output;
      };
    }

    const originalSetBlendFrames = layer.setBlendFrames;
    if (typeof originalSetBlendFrames === "function") {
      layer.setBlendFrames = function (...args) {
        const output = originalSetBlendFrames.apply(this, args);
        schedule(0);
        return output;
      };
    }

    layer.map?.on?.("moveend", () => schedule(0));
    layer.map?.on?.("zoomend", () => schedule(0));

    console.info(
      "MRALA archive player v13: forward GPU runway anchored to actual playback timeline • expected steady refill is roughly one frame of textures per tick"
    );

    return result;
  };

  setInterval(() => {
    const playing = /Pause/i.test(String(document.getElementById("playPause")?.textContent || ""));
    if (playing) schedule(0);
  }, PERIODIC_MS);
})();
