(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MOBILE = matchMedia?.("(pointer: coarse)")?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Keep the immediately-next observations hot, then build the rest of the
  // runway one frame at a time. Any fill anchored to an old slider position
  // is abandoned as soon as playback advances so cache->GPU work never chases
  // stale observations.
  const HOT_RUNWAY = MOBILE ? 2 : 3;
  const TARGET_RUNWAY = MOBILE ? 6 : 12;
  const GPU_BUDGET_BYTES = (MOBILE ? 176 : 320) * 1048576;
  const LOAD_CONCURRENCY = MOBILE ? 2 : 6;
  const BACKGROUND_BATCH_FRAMES = 1;
  const PERIODIC_MS = MOBILE ? 140 : 70;
  const BACKGROUND_GAP_MS = MOBILE ? 24 : 10;

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

  function sliderIndex(frames) {
    if (!frames.length) return -1;
    const slider = document.getElementById("frameSlider");
    const index = Math.round(Number(slider?.value));
    if (!Number.isFinite(index)) return frames.length - 1;
    return Math.max(0, Math.min(frames.length - 1, index));
  }

  function sliderValue() {
    return String(document.getElementById("frameSlider")?.value ?? "");
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

  function targetFramesFromTimeline(count, anchorIndex) {
    const frames = timelineFrames();
    if (!frames.length) return [];
    let current = Number.isFinite(anchorIndex) ? anchorIndex : sliderIndex(frames);
    current = Math.max(0, Math.min(frames.length - 1, current));
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

  async function loadFrames(layer, frames, chunks, pins, anchorValue) {
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
    let stale = false;

    async function worker() {
      while (cursor < targets.length) {
        if (anchorValue !== sliderValue()) {
          stale = true;
          return;
        }
        const target = targets[cursor++];
        try {
          if (await ensureTexture(layer, target.frame, target.chunk, pins)) loaded += 1;
        } catch {}
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) }, () => worker())
    );
    return { loaded, stale: stale || anchorValue !== sliderValue() };
  }

  function cancelLegacyRunway(layer) {
    if (!layer) return;
    if (layer.__zwxRunwayTimer) {
      clearTimeout(layer.__zwxRunwayTimer);
      layer.__zwxRunwayTimer = 0;
    }
    layer.__zwxRunwayGeneration = Number(layer.__zwxRunwayGeneration || 0) + 1;
    layer.__zwxPinnedGpuKeys = new Set();
    layer.__zwxRunwayFrames = 0;
  }

  async function fillTimelineRunway() {
    const layer = nativeLayer;
    if (!layer?.enabled || !layer.__zwxHdLocked) return { needsMore: false };

    cancelLegacyRunway(layer);

    const ids = visibleIds(layer);
    if (!ids.length) return { needsMore: false };

    const byId = chunkMap();
    const chunks = ids.map(id => byId.get(id)).filter(Boolean);
    if (!chunks.length) return { needsMore: false };

    const timeline = timelineFrames();
    const anchorIndex = sliderIndex(timeline);
    const anchorValue = sliderValue();
    if (anchorIndex < 0) return { needsMore: false };

    const count = runwayCount(ids);
    const frames = targetFramesFromTimeline(count, anchorIndex);
    if (!frames.length) return { needsMore: false };

    const previousPins = new Set(layer.__zwxV13TimelineRunwayKeys || []);
    const targetPins = new Set();
    for (const frame of frames) {
      for (const chunk of chunks) targetPins.add(textureKey(frame.id, chunk.id));
    }

    // Retain the previous runway while the replacement is staged.
    const loadingPins = new Set([...previousPins, ...targetPins]);
    layer.__zwxV13TimelineRunwayKeys = loadingPins;

    // First priority: only the immediately-next few displayed observations.
    // If playback advances while these are loading, abandon the stale batch
    // immediately and re-anchor on the new slider position.
    const hotFrames = frames.slice(0, Math.min(HOT_RUNWAY, frames.length));
    const hotResult = await loadFrames(layer, hotFrames, chunks, loadingPins, anchorValue);

    if (hotResult.stale) {
      layer.__zwxV13TimelineRunwayKeys = previousPins;
      return { needsMore: true, stale: true };
    }

    // Add just one farther-ahead frame per pass. This keeps cache->GPU uploads
    // small enough that presentation isn't starved by background work.
    const backgroundCandidates = frames.slice(hotFrames.length);
    const backgroundFrames = [];
    for (const frame of backgroundCandidates) {
      if (!frameComplete(layer, frame, chunks)) backgroundFrames.push(frame);
      if (backgroundFrames.length >= BACKGROUND_BATCH_FRAMES) break;
    }

    let backgroundLoaded = 0;
    if (backgroundFrames.length) {
      const backgroundResult = await loadFrames(
        layer,
        backgroundFrames,
        chunks,
        loadingPins,
        anchorValue
      );
      backgroundLoaded = backgroundResult.loaded;
      if (backgroundResult.stale) {
        layer.__zwxV13TimelineRunwayKeys = previousPins;
        return { needsMore: true, stale: true };
      }
    }

    layer.__zwxV13TimelineRunwayKeys = targetPins;
    layer.map?.triggerRepaint?.();

    const completeCount = frames.reduce(
      (sum, frame) => sum + (frameComplete(layer, frame, chunks) ? 1 : 0),
      0
    );
    const hotComplete = hotFrames.every(frame => frameComplete(layer, frame, chunks));
    const needsMore = completeCount < frames.length;

    const signature = `${anchorValue}:${frames[0]?.id || ""}:${count}:${completeCount}:${ids.join("|")}`;
    if (hotResult.loaded || backgroundLoaded || signature !== lastSignature) {
      lastSignature = signature;
      console.info(
        "MRALA v13.3 live runway:",
        Math.min(HOT_RUNWAY, frames.length) + " immediate / " + count + " target frames ahead",
        ids.length + " chunks/frame",
        "• " + completeCount + " currently complete",
        "• uploaded " + hotResult.loaded + " immediate + " + backgroundLoaded + " background texture(s)",
        hotComplete ? "• immediate lane ready" : "• immediate lane still filling"
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
        if (result?.needsMore || result?.stale) pending = true;
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (pending) schedule(BACKGROUND_GAP_MS);
      });
  }

  function schedule(delay = 0) {
    if (!nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;
    cancelLegacyRunway(nativeLayer);
    pending = true;
    if (busy || timer) return;
    timer = setTimeout(runScheduled, Math.max(0, delay));
  }

  window.__ZWX_MRALA_REQUEST_TIMELINE_RUNWAY__ = () => schedule(0);

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== NATIVE_ID || layer.__zwxTimelineRunwayV13Patched) return result;

    layer.__zwxTimelineRunwayV13Patched = true;
    nativeLayer = layer;
    layer.__zwxV13TimelineRunwayKeys = new Set();
    cancelLegacyRunway(layer);

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
      "MRALA archive player v13.3: immediate next-frame priority • stale runway fills abort on timeline advance • one-frame background staging • v13 owns steady-state GPU runway"
    );

    return result;
  };

  setInterval(() => {
    const playing = /Pause/i.test(String(document.getElementById("playPause")?.textContent || ""));
    if (playing) schedule(0);
  }, PERIODIC_MS);
})();