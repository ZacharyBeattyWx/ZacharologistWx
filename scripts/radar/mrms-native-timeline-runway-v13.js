(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MOBILE = matchMedia?.("(pointer: coarse)")?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Keep a small immediately-playable hot lane, then grow a modest cushion in
  // tiny batches. This avoids the old 100+ texture upload burst that could
  // monopolize the main/GPU thread and feel like playback stutter.
  const HOT_RUNWAY = MOBILE ? 4 : 8;
  const TARGET_RUNWAY = MOBILE ? 8 : 18;
  const GPU_BUDGET_BYTES = (MOBILE ? 176 : 320) * 1048576;
  const LOAD_CONCURRENCY = MOBILE ? 2 : 6;
  const BACKGROUND_BATCH_FRAMES = MOBILE ? 1 : 2;
  const PERIODIC_MS = MOBILE ? 180 : 100;
  const BACKGROUND_GAP_MS = MOBILE ? 28 : 16;

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
    if (!bytesPerFrame) return HOT_RUNWAY;
    const budgetCount = Math.max(HOT_RUNWAY, Math.floor(GPU_BUDGET_BYTES / bytesPerFrame));
    return Math.max(HOT_RUNWAY, Math.min(TARGET_RUNWAY, budgetCount));
  }

  function playbackIndex(frames) {
    if (!frames.length) return -1;
    const slider = document.getElementById("frameSlider");
    const index = Math.round(Number(slider?.value));
    if (!Number.isFinite(index)) return frames.length - 1;
    return Math.max(0, Math.min(frames.length - 1, index));
  }

  const X2_BUCKET_MS = 5 * 60 * 1000;

  function fiveMinuteX2Enabled() {
    return String(
      document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent || ""
    ).trim() === "2×";
  }

  function nextDisplayIndex(frames, current) {
    if (!frames.length) return -1;
    const index = Math.max(0, Math.min(frames.length - 1, Number(current) || 0));
    const sequential = (index + 1) % frames.length;
    if (!fiveMinuteX2Enabled() || index === frames.length - 1) return sequential;

    const currentMs = frameMs(frames[index]);
    if (!Number.isFinite(currentMs)) return sequential;
    const nextBucket = (Math.floor(currentMs / X2_BUCKET_MS) + 1) * X2_BUCKET_MS;

    for (let candidate = index + 1; candidate < frames.length; candidate += 1) {
      const candidateMs = frameMs(frames[candidate]);
      if (Number.isFinite(candidateMs) && candidateMs >= nextBucket) return candidate;
    }
    return frames.length - 1;
  }

  function targetFramesFromTimeline(count) {
    const frames = timelineFrames();
    if (!frames.length) return [];
    let current = playbackIndex(frames);
    if (current < 0) return [];

    const targets = [];
    const seen = new Set([current]);
    while (targets.length < count) {
      current = nextDisplayIndex(frames, current);
      if (current < 0 || seen.has(current)) break;
      seen.add(current);
      const frame = frames[current];
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

  function frameComplete(layer, frame, chunks) {
    return chunks.every(chunk => layer.textures?.has(textureKey(frame.id, chunk.id)));
  }

  async function loadFrames(layer, frames, chunks, pins) {
    const targets = [];
    for (const frame of frames) {
      for (const chunk of chunks) {
        const key = textureKey(frame.id, chunk.id);
        pins.add(key);
        if (!layer.textures?.has(key)) targets.push({ frame, chunk });
      }
    }

    let cursor = 0;
    let loaded = 0;
    async function worker() {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        try {
          if (await ensureTexture(layer, target.frame, target.chunk, pins)) loaded += 1;
        } catch {}
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) }, () => worker())
    );
    return loaded;
  }

  async function fillTimelineRunway() {
    const layer = nativeLayer;
    if (!layer?.enabled || !layer.__zwxHdLocked) return { needsMore: false };

    const ids = visibleIds(layer);
    if (!ids.length) return { needsMore: false };

    const byId = chunkMap();
    const chunks = ids.map(id => byId.get(id)).filter(Boolean);
    if (!chunks.length) return { needsMore: false };

    const count = runwayCount(ids);
    const frames = targetFramesFromTimeline(count);
    if (!frames.length) return { needsMore: false };

    const previousPins = new Set(layer.__zwxV13TimelineRunwayKeys || []);
    const targetPins = new Set();
    for (const frame of frames) {
      for (const chunk of chunks) targetPins.add(textureKey(frame.id, chunk.id));
    }

    // Retain the previous runway while the replacement is being staged so a
    // refill can never evict the frame currently being rendered.
    const loadingPins = new Set([...previousPins, ...targetPins]);
    layer.__zwxV13TimelineRunwayKeys = loadingPins;

    const hotFrames = frames.slice(0, Math.min(HOT_RUNWAY, frames.length));
    const hotLoaded = await loadFrames(layer, hotFrames, chunks, loadingPins);

    // Only add a couple of farther-ahead frames per pass. The scheduler will
    // come back quickly and grow the cushion without one huge GPU upload burst.
    const backgroundCandidates = frames.slice(hotFrames.length);
    const backgroundFrames = [];
    for (const frame of backgroundCandidates) {
      if (!frameComplete(layer, frame, chunks)) backgroundFrames.push(frame);
      if (backgroundFrames.length >= BACKGROUND_BATCH_FRAMES) break;
    }

    let backgroundLoaded = 0;
    if (backgroundFrames.length) {
      backgroundLoaded = await loadFrames(layer, backgroundFrames, chunks, loadingPins);
    }

    layer.__zwxV13TimelineRunwayKeys = targetPins;
    layer.map?.triggerRepaint?.();

    const completeCount = frames.reduce(
      (sum, frame) => sum + (frameComplete(layer, frame, chunks) ? 1 : 0),
      0
    );
    const hotComplete = hotFrames.every(frame => frameComplete(layer, frame, chunks));
    const needsMore = completeCount < frames.length;

    const slider = document.getElementById("frameSlider");
    const signature = `${slider?.value || "?"}:${frames[0]?.id || ""}:${count}:${completeCount}:${ids.join("|")}`;
    if (hotLoaded || backgroundLoaded || signature !== lastSignature) {
      lastSignature = signature;
      console.info(
        "MRALA v13.2 staged runway:",
        Math.min(HOT_RUNWAY, frames.length) + " hot / " + count + " target frames ahead",
        ids.length + " chunks/frame",
        "• " + completeCount + " currently complete",
        "• uploaded " + hotLoaded + " hot + " + backgroundLoaded + " background texture(s)",
        hotComplete ? "• hot lane ready" : "• hot lane still filling"
      );
    }

    return { needsMore };
  }

  function runScheduled() {
    timer = 0;
    if (busy || !nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;

    busy = true;
    pending = false;
    fillTimelineRunway()
      .then(result => {
        if (result?.needsMore) pending = true;
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (pending) schedule(BACKGROUND_GAP_MS);
      });
  }

  function schedule(delay = 0) {
    if (!nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;
    pending = true;
    if (busy || timer) return;
    timer = setTimeout(runScheduled, Math.max(0, delay));
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
      "MRALA archive player v13.2: staged hot runway follows actual display sequence • 2x preloads only 5-minute targets"
    );

    return result;
  };

  setInterval(() => {
    const playing = /Pause/i.test(String(document.getElementById("playPause")?.textContent || ""));
    if (playing) schedule(0);
  }, PERIODIC_MS);
})();