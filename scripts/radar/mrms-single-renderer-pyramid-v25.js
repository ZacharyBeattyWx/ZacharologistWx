(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_PYRAMID_V25__) return;
  window.__ZWX_MRALA_PYRAMID_V25__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Keep mobile on the proven core path while the desktop pyramid path is
  // validated. The desktop path uses one renderer and one MRMS timeline only.
  if (MOBILE) {
    console.info("MRALA v25: mobile unchanged while desktop pyramid is validated");
    return;
  }

  const FETCH_CONCURRENCY = 8;
  const FULL_LOOP_CAP_BYTES = 420 * 1048576;
  const VIEWPORT_PAD = 0.10;

  // Hysteresis keeps minor wheel/pinch changes from bouncing resolution levels.
  const F2_ENTER_ZOOM = 4.90;
  const F2_EXIT_ZOOM = 4.50;
  const F1_ENTER_ZOOM = 6.00;
  const F1_EXIT_ZOOM = 5.60;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxMralaPyramidV25Installed) return;
  mapPrototype.__zwxMralaPyramidV25Installed = true;

  let manifest = null;
  let map = null;
  let overviewLayer = null;
  let nativeLayer = null;

  let baseSetVisible = null;
  let baseSetEnabled = null;
  let baseAddTexture = null;
  let baseActivateFrame = null;
  let baseSetBlendFrames = null;
  let baseEvictExcept = null;

  let currentLevelId = "";
  let currentChunks = [];
  let currentViewportSignature = "";
  let reserveKeys = new Set();
  let generation = 0;
  let refreshTimer = 0;
  let refreshBusy = false;
  let refreshPending = false;
  let bypassPlayGate = false;

  const inflight = new Map();

  function isPlaying() {
    return /Pause/i.test(String(document.getElementById("playPause")?.textContent || ""));
  }

  function isOverviewKey(key) {
    return String(key || "").startsWith("overview:");
  }

  function frameIdFromOverviewKey(key) {
    const text = String(key || "");
    return text.startsWith("overview:") ? text.slice("overview:".length) : "";
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function timelineFrames() {
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

  function pyramidLevels() {
    const configured = Array.isArray(manifest?.resolutionPyramid?.levels)
      ? manifest.resolutionPyramid.levels
      : [];
    const levels = new Map(
      configured
        .filter(level => level?.id && Array.isArray(level?.layout))
        .map(level => [String(level.id), level])
    );

    // Keep a native fallback even if an older manifest is briefly observed.
    if (!levels.has("f1") && manifest?.nativeChunking?.layout) {
      levels.set("f1", {
        id: "f1",
        factor: 1,
        width: Number(manifest.imageWidth),
        height: Number(manifest.imageHeight),
        template: manifest.nativeChunking.template,
        layout: manifest.nativeChunking.layout
      });
    }
    return levels;
  }

  function levelReady(levelId, frames) {
    if (levelId === "f1") return frames.every(frame => frame?.nativeChunksReady);
    return frames.every(frame =>
      Array.isArray(frame?.pyramidLevelsReady) &&
      frame.pyramidLevelsReady.map(String).includes(levelId)
    );
  }

  function visibleChunks(level) {
    if (!map || !level) return [];
    const bounds = map.getBounds?.();
    if (!bounds) return [];

    let west = bounds.getWest();
    let east = bounds.getEast();
    let south = bounds.getSouth();
    let north = bounds.getNorth();

    const lonPad = Math.max(0.02, Math.abs(east - west) * VIEWPORT_PAD);
    const latPad = Math.max(0.02, Math.abs(north - south) * VIEWPORT_PAD);
    west -= lonPad;
    east += lonPad;
    south -= latPad;
    north += latPad;

    return (level.layout || []).filter(chunk => {
      const b = (chunk?.bounds || []).map(Number);
      if (b.length !== 4 || b.some(value => !Number.isFinite(value))) return false;
      const [cw, cs, ce, cn] = b;
      return ce >= west && cw <= east && cn >= south && cs <= north;
    });
  }

  function rawBytesFor(frames, chunks) {
    const perFrame = chunks.reduce(
      (sum, chunk) =>
        sum +
        Math.max(1, Number(chunk?.width) || 1) *
        Math.max(1, Number(chunk?.height) || 1),
      0
    );
    return perFrame * frames.length;
  }

  function levelCandidatesForZoom(zoom) {
    const allowF1 = currentLevelId === "f1"
      ? zoom >= F1_EXIT_ZOOM
      : zoom >= F1_ENTER_ZOOM;
    const allowF2 = currentLevelId === "f2"
      ? zoom >= F2_EXIT_ZOOM
      : zoom >= F2_ENTER_ZOOM;

    const candidates = [];
    if (allowF1) candidates.push("f1");
    if (allowF2) candidates.push("f2");
    candidates.push("f4");
    return candidates;
  }

  function chooseLevel(frames) {
    const levels = pyramidLevels();
    const zoom = Number(map?.getZoom?.() || 0);
    const candidates = levelCandidatesForZoom(zoom);

    for (const levelId of candidates) {
      const level = levels.get(levelId);
      if (!level || !levelReady(levelId, frames)) continue;
      const chunks = visibleChunks(level);
      if (!chunks.length) continue;
      const fullLoopBytes = rawBytesFor(frames, chunks);
      if (fullLoopBytes <= FULL_LOOP_CAP_BYTES) {
        return { level, chunks, fullLoopBytes, zoom };
      }
    }

    // f4 is expected to fit even for a CONUS viewport. If it does not, select
    // the coarsest available level rather than falling back to another renderer.
    for (const levelId of ["f4", "f2", "f1"]) {
      const level = levels.get(levelId);
      if (!level || !levelReady(levelId, frames)) continue;
      const chunks = visibleChunks(level);
      if (!chunks.length) continue;
      return {
        level,
        chunks,
        fullLoopBytes: rawBytesFor(frames, chunks),
        zoom
      };
    }
    return null;
  }

  function textureKey(frameId, chunkId) {
    return `${frameId}:${chunkId}`;
  }

  function chunkUrl(level, frameId, chunkId) {
    const template = String(level?.template || "native-chunks/{frameId}/{chunkId}.dbz")
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));
    return new URL(template, BASE).toString();
  }

  function viewportSignature(level, chunks) {
    return `${String(level?.id || "")}|${chunks.map(chunk => String(chunk.id)).sort().join("|")}`;
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

  async function fetchRaw(level, frame, chunk) {
    const url = chunkUrl(level, frame.id, chunk.id);
    if (inflight.has(url)) return inflight.get(url);

    const promise = (async () => {
      const response = await window.fetch(url, {
        cache: "force-cache",
        priority: "high"
      });
      if (!response.ok) {
        throw new Error(`MRALA pyramid ${level.id} HTTP ${response.status}`);
      }

      const expected =
        Math.max(1, Number(chunk?.width) || 1) *
        Math.max(1, Number(chunk?.height) || 1);
      const raw = await unpack(await response.arrayBuffer(), expected);
      if (raw.byteLength !== expected) {
        throw new Error(
          `MRALA pyramid ${level.id} ${chunk.id} size ${raw.byteLength} != ${expected}`
        );
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

  function clockState() {
    const fromId = frameIdFromOverviewKey(overviewLayer?.activeKey);
    const nextId = frameIdFromOverviewKey(overviewLayer?.nextKey) || fromId;
    const mix = Math.max(0, Math.min(1, Number(overviewLayer?.mixAmount || 0)));
    const blending = Boolean(overviewLayer?.nextKey) && mix > 0;
    return { fromId, nextId, mix, blending };
  }

  function anchorIndex(frames) {
    const activeId = clockState().fromId;
    if (activeId) {
      const found = frames.findIndex(frame => String(frame.id) === activeId);
      if (found >= 0) return found;
    }
    const slider = Math.round(Number(document.getElementById("frameSlider")?.value));
    if (Number.isFinite(slider)) return Math.max(0, Math.min(frames.length - 1, slider));
    return Math.max(0, frames.length - 1);
  }

  function pausedWarmFrames(frames, count = 5) {
    if (!frames.length) return [];
    const start = anchorIndex(frames);
    const result = [];
    const seen = new Set();
    let index = start;
    while (result.length < Math.min(count, frames.length) && !seen.has(index)) {
      seen.add(index);
      result.push(frames[index]);
      index = (index + 1) % frames.length;
    }

    const state = clockState();
    for (const frameId of [state.fromId, state.nextId]) {
      const frame = frames.find(item => String(item.id) === frameId);
      if (frame && !result.includes(frame)) result.unshift(frame);
    }
    return result;
  }

  function frameComplete(frame, chunks) {
    return chunks.every(chunk =>
      nativeLayer?.textures?.has(textureKey(frame.id, chunk.id))
    );
  }

  function keysFor(frames, chunks) {
    const keys = new Set();
    for (const frame of frames) {
      for (const chunk of chunks) keys.add(textureKey(frame.id, chunk.id));
    }
    return keys;
  }

  function syncNativeToClock() {
    if (!nativeLayer || !overviewLayer) return false;
    const ids = (nativeLayer.visibleIds || []).map(String);
    if (!ids.length) return false;

    const state = clockState();
    if (!state.fromId || !nativeLayer.hasFrame?.(state.fromId, ids)) return false;
    if (state.blending && !nativeLayer.hasFrame?.(state.nextId, ids)) return false;

    if (state.blending && typeof baseSetBlendFrames === "function") {
      return Boolean(
        baseSetBlendFrames.call(nativeLayer, state.fromId, state.nextId, state.mix)
      );
    }
    if (typeof baseActivateFrame === "function") {
      return Boolean(baseActivateFrame.call(nativeLayer, state.fromId));
    }
    return false;
  }

  async function preload(level, frames, chunks, { progress = false } = {}) {
    if (!nativeLayer || !level || !frames.length || !chunks.length) return false;

    const localGeneration = generation;
    const signature = viewportSignature(level, chunks);
    const tasks = [];
    const missingByFrame = new Map();
    let readyFrames = 0;

    for (const frame of frames) {
      const missing = chunks.filter(
        chunk => !nativeLayer.textures?.has(textureKey(frame.id, chunk.id))
      );
      if (!missing.length) {
        readyFrames += 1;
      } else {
        missingByFrame.set(String(frame.id), missing.length);
        for (const chunk of missing) tasks.push({ frame, chunk });
      }
    }

    const button = document.getElementById("playPause");
    const originalText = button?.textContent || "▶ Play";
    const updateProgress = () => {
      if (progress && button && !isPlaying()) {
        button.textContent = `Loading ${level.id} ${readyFrames}/${frames.length}…`;
      }
    };
    updateProgress();

    let cursor = 0;
    async function worker() {
      while (cursor < tasks.length) {
        if (localGeneration !== generation) return;
        const task = tasks[cursor++];
        try {
          const raw = await fetchRaw(level, task.frame, task.chunk);
          if (localGeneration !== generation) return;
          if (viewportSignature(level, chunks) !== signature) return;
          baseAddTexture?.call(nativeLayer, task.frame.id, task.chunk, raw);

          const frameId = String(task.frame.id);
          const left = Math.max(0, (missingByFrame.get(frameId) || 1) - 1);
          missingByFrame.set(frameId, left);
          if (left === 0) {
            readyFrames += 1;
            updateProgress();
          }
        } catch (error) {
          console.warn("MRALA v25 pyramid chunk failed", error);
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
      if (localGeneration !== generation) return false;
      return frames.every(frame => frameComplete(frame, chunks));
    } finally {
      if (progress && button && !isPlaying()) button.textContent = originalText;
    }
  }

  async function refreshViewport({ fullForPlay = false, progress = false, reason = "refresh" } = {}) {
    if (refreshBusy) {
      refreshPending = true;
      return false;
    }
    if (!manifest || !nativeLayer || !map) return false;

    refreshBusy = true;
    try {
      const frames = timelineFrames();
      if (!frames.length) return false;

      const choice = chooseLevel(frames);
      if (!choice) return false;

      const { level, chunks, fullLoopBytes, zoom } = choice;
      const targetSignature = viewportSignature(level, chunks);
      const changed = targetSignature !== currentViewportSignature;
      const playing = isPlaying() || fullForPlay;
      const targetFrames = playing ? frames : pausedWarmFrames(frames);

      // During a level/viewport transition keep a small runway of the currently
      // visible level protected while the complete target loop loads. The old
      // level remains on-screen until the target is genuinely ready.
      const protectedKeys = new Set();
      if (currentChunks.length) {
        for (const key of keysFor(pausedWarmFrames(frames, 12), currentChunks)) {
          protectedKeys.add(key);
        }
      }
      for (const key of keysFor(targetFrames, chunks)) protectedKeys.add(key);
      reserveKeys = protectedKeys;

      const ready = await preload(level, targetFrames, chunks, { progress });
      if (!ready) return false;

      if (changed) {
        baseSetVisible?.call(nativeLayer, chunks.map(chunk => String(chunk.id)));
        baseSetEnabled?.call(nativeLayer, true);
        currentLevelId = String(level.id);
        currentChunks = chunks;
        currentViewportSignature = targetSignature;
      }

      syncNativeToClock();
      nativeLayer.map?.triggerRepaint?.();

      reserveKeys = keysFor(targetFrames, chunks);
      baseEvictExcept?.call(nativeLayer, reserveKeys);

      if (changed || progress || reason === "play") {
        console.info(
          "MRALA v25 pyramid:",
          `${level.id} @ z${zoom.toFixed(2)}`,
          `• ${chunks.length} chunks/frame`,
          `• ${(fullLoopBytes / 1048576).toFixed(0)} MiB full loop`,
          playing ? `• ${frames.length}/${frames.length} frames resident before switch` : `• ${targetFrames.length} warm frame(s)`,
          changed ? "• atomic single-renderer switch" : "• same level"
        );
      }
      return true;
    } finally {
      refreshBusy = false;
      if (refreshPending) {
        refreshPending = false;
        scheduleRefresh(0);
      }
    }
  }

  function scheduleRefresh(delay = 100) {
    if (!map) return;
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      refreshViewport({ fullForPlay: isPlaying(), progress: false }).catch(error =>
        console.warn("MRALA v25 viewport refresh failed", error)
      );
    }, Math.max(0, delay));
  }

  // Capture the manifest before the core player consumes it.
  const previousFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const response = await previousFetch(input, init);
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (response.ok && MANIFEST_RE.test(url)) {
      try {
        manifest = await response.clone().json();
        if (!manifest?.resolutionPyramid?.readyForPlayback) {
          console.warn("MRALA v25: pyramid manifest is not fully ready; native fallback may be used");
        }
        scheduleRefresh(0);
      } catch (error) {
        console.warn("MRALA v25 manifest capture failed", error);
      }
    }
    return response;
  };

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxPyramidClockPatched) {
      layer.__zwxPyramidClockPatched = true;
      overviewLayer = layer;
      map = layer.map || map;

      // Keep the existing core timeline controls, but make the old overview
      // layer a zero-data clock. It never downloads or renders radar imagery.
      layer.hasTexture = key => isOverviewKey(key);
      layer.activate = function(key) {
        this.activeKey = String(key);
        this.nextKey = "";
        this.mixAmount = 0;
        syncNativeToClock();
        this.map?.triggerRepaint?.();
        return true;
      };
      layer.setBlend = function(fromKey, toKey, amount) {
        this.activeKey = String(fromKey);
        this.nextKey = String(toKey);
        this.mixAmount = Math.max(0, Math.min(1, Number(amount) || 0));
        syncNativeToClock();
        this.map?.triggerRepaint?.();
        return true;
      };
      layer.render = function() {};
      layer.evictExcept = function() {};
      layer.trimTo = function() {};
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxPyramidLayerPatched) {
      layer.__zwxPyramidLayerPatched = true;
      nativeLayer = layer;
      map = layer.map || map;

      baseSetVisible = layer.setVisible;
      baseSetEnabled = layer.setEnabled;
      baseAddTexture = layer.addTexture;
      baseActivateFrame = layer.activateFrame;
      baseSetBlendFrames = layer.setBlendFrames;
      baseEvictExcept = layer.evictExcept;

      // v25 owns visibility and level selection. The core player may still try
      // to clear/swap the old native LOD, but there is now only one radar renderer.
      layer.setEnabled = function() {
        return baseSetEnabled?.call(this, true);
      };
      layer.setVisible = function() {
        return;
      };
      layer.evictExcept = function(keep) {
        const combined = new Set(keep || []);
        for (const key of reserveKeys) combined.add(key);
        return baseEvictExcept?.call(this, combined);
      };

      baseSetEnabled?.call(layer, true);
      scheduleRefresh(0);

      map?.on?.("zoomend", () => {
        generation += 1;
        scheduleRefresh(0);
      });
      map?.on?.("moveend", () => {
        generation += 1;
        scheduleRefresh(0);
      });
    }

    return result;
  };

  // Play starts only after the complete selected-resolution loop for the current
  // viewport is resident. Because chooseLevel() enforces the memory cap, the
  // browser never has to chase a rolling buffer during normal playback.
  document.addEventListener(
    "click",
    event => {
      const button = event.target?.closest?.("#playPause");
      if (!button || bypassPlayGate || isPlaying() || !nativeLayer || !manifest) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      button.disabled = true;
      const originalText = button.textContent || "▶ Play";

      refreshViewport({ fullForPlay: true, progress: true, reason: "play" })
        .then(ready => {
          if (!ready) return;
          bypassPlayGate = true;
          button.click();
          bypassPlayGate = false;
        })
        .catch(error => console.warn("MRALA v25 Play preload failed", error))
        .finally(() => {
          button.disabled = false;
          if (!isPlaying()) button.textContent = originalText;
        });
    },
    true
  );

  window.__ZWX_MRALA_PYRAMID_STATE__ = () => {
    const frames = timelineFrames();
    const choice = frames.length ? chooseLevel(frames) : null;
    return {
      active: Boolean(nativeLayer),
      pyramidReady: Boolean(manifest?.resolutionPyramid?.readyForPlayback),
      currentLevel: currentLevelId,
      selectedLevel: String(choice?.level?.id || ""),
      zoom: Number(map?.getZoom?.() || 0),
      frames: frames.length,
      viewportChunks: choice?.chunks?.length || 0,
      fullLoopMiB: choice ? Number((choice.fullLoopBytes / 1048576).toFixed(1)) : 0,
      capMiB: FULL_LOOP_CAP_BYTES / 1048576,
      nativeTextures: Number(nativeLayer?.textures?.size || 0),
      overviewTextures: Number(overviewLayer?.textures?.size || 0),
      overviewIsVirtualClockOnly: Boolean(overviewLayer)
    };
  };

  console.info(
    "MRALA v25: single renderer + single MRMS timeline + f4/f2/f1 resolution pyramid • full selected loop loads before playback/LOD switch"
  );
})();