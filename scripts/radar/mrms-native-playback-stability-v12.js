(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MOBILE = matchMedia?.("(pointer: coarse)")?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const DESIRED_RUNWAY = MOBILE ? 10 : 30;
  const GPU_BUDGET_BYTES = (MOBILE ? 176 : 384) * 1048576;
  const LOAD_CONCURRENCY = MOBILE ? 3 : 8;
  const PERIODIC_MS = MOBILE ? 260 : 140;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxPlaybackStabilityV12Installed) return;
  mapPrototype.__zwxPlaybackStabilityV12Installed = true;

  let nativeLayer = null;
  let overviewLayer = null;
  let warmGeneration = 0;
  let warmTimer = 0;
  let warmBusy = false;
  let warmPending = false;
  let lastRunwaySignature = "";
  let lastHoldLog = 0;

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
      .filter(frame => frame?.id && Number.isFinite(frameMs(frame)))
      .sort((a, b) => frameMs(a) - frameMs(b));
  }

  function nativeFrames() {
    return timelineFrames().filter(frame => frame?.nativeChunksReady);
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

  function currentNativeIndex(layer, frames) {
    if (!frames.length) return -1;

    const from = String(layer?.fromFrame || "");
    let index = frames.findIndex(frame => String(frame.id) === from);
    if (index >= 0) return index;

    const slider = document.getElementById("frameSlider");
    const all = timelineFrames();
    const sliderIndex = Math.max(0, Math.min(all.length - 1, Number(slider?.value || 0)));
    const currentId = String(all[sliderIndex]?.id || "");
    index = frames.findIndex(frame => String(frame.id) === currentId);
    if (index >= 0) return index;

    return 0;
  }

  function orderedNativeFrames(layer = nativeLayer) {
    const frames = nativeFrames();
    if (!frames.length) return [];
    const index = currentNativeIndex(layer, frames);
    if (index < 0) return frames;
    return [...frames.slice(index), ...frames.slice(0, index)];
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

  function nextTimelineFrame() {
    const frames = timelineFrames();
    if (!frames.length) return null;
    const slider = document.getElementById("frameSlider");
    const current = Math.max(0, Math.min(frames.length - 1, Number(slider?.value || 0)));
    return frames[(current + 1) % frames.length] || null;
  }

  function nextNativeFrameReady(layer = nativeLayer) {
    if (!layer?.enabled || !layer.__zwxHdLocked) return true;
    if (layer.map?.isMoving?.() || layer.map?.isZooming?.() || layer.map?.isRotating?.()) return true;

    const ids = visibleIds(layer);
    if (!ids.length) return true;
    const next = nextTimelineFrame();
    if (!next?.id || !next?.nativeChunksReady) return false;

    return ids.every(id => layer.textures?.has(textureKey(next.id, id)));
  }

  async function fillRunway() {
    const layer = nativeLayer;
    if (!layer?.enabled || !layer.__zwxHdLocked) return;

    const ids = visibleIds(layer);
    const ordered = orderedNativeFrames(layer);
    if (!ids.length || !ordered.length) return;

    const byId = chunkMap();
    const chunks = ids.map(id => byId.get(id)).filter(Boolean);
    if (!chunks.length) return;

    const count = Math.min(runwayCount(ids), ordered.length);
    const frames = ordered.slice(0, count);
    const generation = ++warmGeneration;
    const previousPins = new Set(layer.__zwxV12RunwayKeys || []);
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

    layer.__zwxV12RunwayKeys = loadingPins;
    let cursor = 0;
    let loaded = 0;

    async function worker() {
      while (cursor < targets.length) {
        if (generation !== warmGeneration) return;
        const target = targets[cursor++];
        try {
          if (await ensureTexture(layer, target.frame, target.chunk, loadingPins)) loaded += 1;
        } catch {}
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) }, () => worker())
    );
    if (generation !== warmGeneration) return;

    layer.__zwxV12RunwayKeys = targetPins;
    layer.map?.triggerRepaint?.();

    const nextSignature = `${count}:${ids.join("|")}`;
    if (loaded || nextSignature !== lastRunwaySignature) {
      lastRunwaySignature = nextSignature;
      console.info(
        "MRALA v12 native runway READY:",
        count + " frames ahead",
        ids.length + " chunks/frame",
        loaded ? loaded + " texture(s) filled from local archive/cache" : "already resident",
        "• overview disabled after HD lock"
      );
    }
  }

  function scheduleRunway(delay = 0) {
    if (!nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;
    warmPending = true;
    if (warmBusy || warmTimer) return;
    warmTimer = setTimeout(async () => {
      warmTimer = 0;
      if (warmBusy) return;
      warmBusy = true;
      try {
        do {
          warmPending = false;
          await fillRunway();
        } while (warmPending);
      } finally {
        warmBusy = false;
      }
    }, Math.max(0, delay));
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeOnlyV12Patched) {
      layer.__zwxNativeOnlyV12Patched = true;
      overviewLayer = layer;
      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function (...renderArgs) {
          if (nativeLayer?.enabled && nativeLayer.__zwxHdLocked) return;
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxPlaybackStabilityV12Patched) {
      layer.__zwxPlaybackStabilityV12Patched = true;
      nativeLayer = layer;
      layer.__zwxV12RunwayKeys = new Set();

      const originalEvictExcept = layer.evictExcept;
      if (typeof originalEvictExcept === "function") {
        layer.evictExcept = function (keep) {
          const combined = new Set(keep || []);
          for (const key of this.__zwxV12RunwayKeys || []) combined.add(key);
          return originalEvictExcept.call(this, combined);
        };
      }

      const originalSetVisible = layer.setVisible;
      if (typeof originalSetVisible === "function") {
        layer.setVisible = function (...setVisibleArgs) {
          const output = originalSetVisible.apply(this, setVisibleArgs);
          scheduleRunway(0);
          return output;
        };
      }

      const originalActivateFrame = layer.activateFrame;
      if (typeof originalActivateFrame === "function") {
        layer.activateFrame = function (...activateArgs) {
          const output = originalActivateFrame.apply(this, activateArgs);
          if (output) scheduleRunway(0);
          return output;
        };
      }

      const originalSetBlendFrames = layer.setBlendFrames;
      if (typeof originalSetBlendFrames === "function") {
        layer.setBlendFrames = function (...blendArgs) {
          const output = originalSetBlendFrames.apply(this, blendArgs);
          scheduleRunway(output === false ? 0 : 18);
          return output;
        };
      }

      const originalSetEnabled = layer.setEnabled;
      if (typeof originalSetEnabled === "function") {
        layer.setEnabled = function (enabled) {
          const output = originalSetEnabled.call(this, enabled);
          if (enabled) scheduleRunway(0);
          else {
            this.__zwxV12RunwayKeys = new Set();
            warmGeneration += 1;
          }
          return output;
        };
      }

      layer.map?.on?.("moveend", () => scheduleRunway(0));
      layer.map?.on?.("zoomend", () => scheduleRunway(0));

      console.info(
        "MRALA archive player v12: native-only after HD lock • stronger forward GPU runway • playback waits for missing next native frame"
      );
    }

    return result;
  };

  setInterval(() => {
    if (!nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;
    const playing = /Pause/i.test(String(document.getElementById("playPause")?.textContent || ""));
    if (playing) scheduleRunway(0);
  }, PERIODIC_MS);

  // Install after mapbox-token.js finishes its own playback-clock wrapper so this
  // guard becomes the outermost playback rAF gate.
  setTimeout(() => {
    if (window.__ZWX_MRALA_V12_RAF_GUARD__) return;
    window.__ZWX_MRALA_V12_RAF_GUARD__ = true;
    const previousRaf = window.requestAnimationFrame.bind(window);

    function isPlaybackTick(callback) {
      if (typeof callback !== "function") return false;
      try { return /\bplaybackTick\b/.test(Function.prototype.toString.call(callback)); }
      catch { return false; }
    }

    window.requestAnimationFrame = function (callback) {
      if (!isPlaybackTick(callback)) return previousRaf(callback);

      const layer = nativeLayer || window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
      if (!layer?.enabled || !layer.__zwxHdLocked || nextNativeFrameReady(layer)) {
        return previousRaf(callback);
      }

      scheduleRunway(0);
      const now = performance.now();
      if (now - lastHoldLog > 1200) {
        lastHoldLog = now;
        console.info("MRALA v12 playback guard HOLD: next native frame not GPU-ready; keeping current sharp frame and timeline together");
      }

      return previousRaf(() => {
        window.requestAnimationFrame(callback);
      });
    };
  }, 0);
})();
