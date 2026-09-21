(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_SINGLE_SOURCE_V24__) return;
  window.__ZWX_MRALA_NATIVE_SINGLE_SOURCE_V24__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // This first pass is intentionally desktop-only. Mobile keeps the existing
  // core path until the single-source desktop behavior is proven stable.
  if (MOBILE) {
    console.info("MRALA v24: mobile unchanged while desktop single-source native is tested");
    return;
  }

  const FETCH_CONCURRENCY = 8;
  const FULL_LOOP_CAP_BYTES = 512 * 1048576;
  const ROLLING_FRAME_COUNT = 8;
  const VIEWPORT_PAD = 0.12;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxNativeSingleSourceV24Installed) return;
  mapPrototype.__zwxNativeSingleSourceV24Installed = true;

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
  let generation = 0;
  let refreshTimer = 0;
  let preloadPromise = null;
  let currentViewportSignature = "";
  let reserveKeys = new Set();
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

    const lonPad = Math.max(0.02, Math.abs(east - west) * VIEWPORT_PAD);
    const latPad = Math.max(0.02, Math.abs(north - south) * VIEWPORT_PAD);
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

  function viewportSignature(chunks = visibleChunks()) {
    return chunks.map(chunk => String(chunk.id)).sort().join("|");
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
        priority: "high"
      });
      if (!response.ok) throw new Error(`Native single-source HTTP ${response.status}`);

      const expected =
        Math.max(1, Number(chunk?.width) || 1) *
        Math.max(1, Number(chunk?.height) || 1);
      const raw = await unpack(await response.arrayBuffer(), expected);
      if (raw.byteLength !== expected) {
        throw new Error(
          `Native single-source chunk ${chunk.id} size ${raw.byteLength} != ${expected}`
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

  function overviewFrameId() {
    return frameIdFromOverviewKey(overviewLayer?.activeKey);
  }

  function anchorIndex(frames) {
    const activeId = overviewFrameId();
    if (activeId) {
      const found = frames.findIndex(frame => String(frame.id) === activeId);
      if (found >= 0) return found;
    }

    const slider = Math.round(Number(document.getElementById("frameSlider")?.value));
    if (Number.isFinite(slider)) return Math.max(0, Math.min(frames.length - 1, slider));
    return Math.max(0, frames.length - 1);
  }

  function rollingFrames(frames, count = ROLLING_FRAME_COUNT) {
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
    return result;
  }

  function frameComplete(frame, chunks) {
    return chunks.every(chunk =>
      nativeLayer?.textures?.has(textureKey(frame.id, chunk.id))
    );
  }

  function syncNativeToClock() {
    if (!nativeLayer || !overviewLayer) return false;
    const ids = (nativeLayer.visibleIds || []).map(String);
    if (!ids.length) return false;

    const fromId = frameIdFromOverviewKey(overviewLayer.activeKey);
    const nextId = frameIdFromOverviewKey(overviewLayer.nextKey) || fromId;
    const mix = Math.max(0, Math.min(1, Number(overviewLayer.mixAmount || 0)));
    const blending = Boolean(overviewLayer.nextKey) && mix > 0;

    if (!fromId || !nativeLayer.hasFrame?.(fromId, ids)) return false;
    if (blending && !nativeLayer.hasFrame?.(nextId, ids)) return false;

    if (blending && typeof baseSetBlendFrames === "function") {
      return Boolean(baseSetBlendFrames.call(nativeLayer, fromId, nextId, mix));
    }

    if (typeof baseActivateFrame === "function") {
      return Boolean(baseActivateFrame.call(nativeLayer, fromId));
    }

    return false;
  }

  function setReserve(frames, chunks) {
    reserveKeys = new Set();
    for (const frame of frames) {
      for (const chunk of chunks) reserveKeys.add(textureKey(frame.id, chunk.id));
    }
  }

  async function preload(frames, chunks, { progress = false } = {}) {
    if (!nativeLayer || !frames.length || !chunks.length) return false;

    const localGeneration = generation;
    const signature = viewportSignature(chunks);
    setReserve(frames, chunks);

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
        button.textContent = `Loading native ${readyFrames}/${frames.length}…`;
      }
    };
    updateProgress();

    const run = (async () => {
      let cursor = 0;
      async function worker() {
        while (cursor < tasks.length) {
          if (localGeneration !== generation) return;
          const task = tasks[cursor++];
          try {
            const raw = await fetchRaw(task.frame, task.chunk);
            if (localGeneration !== generation || viewportSignature(chunks) !== signature) return;
            baseAddTexture?.call(nativeLayer, task.frame.id, task.chunk, raw);

            const frameId = String(task.frame.id);
            const left = Math.max(0, (missingByFrame.get(frameId) || 1) - 1);
            missingByFrame.set(frameId, left);
            if (left === 0) {
              readyFrames += 1;
              updateProgress();
            }
          } catch (error) {
            console.warn("MRALA v24 native chunk failed", error);
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(FETCH_CONCURRENCY, Math.max(1, tasks.length)) },
          () => worker()
        )
      );

      if (localGeneration !== generation) return false;
      syncNativeToClock();
      nativeLayer.map?.triggerRepaint?.();
      return frames.every(frame => frameComplete(frame, chunks));
    })();

    preloadPromise = run;
    try {
      return await run;
    } finally {
      if (preloadPromise === run) preloadPromise = null;
      if (progress && button && !isPlaying()) button.textContent = originalText;
    }
  }

  async function refreshViewport({ fullForPlay = false, progress = false } = {}) {
    if (!manifest || !nativeLayer || !map) return false;

    const frames = timelineFrames();
    const chunks = visibleChunks();
    if (!frames.length || !chunks.length) return false;

    const nextSignature = viewportSignature(chunks);
    const changed = nextSignature !== currentViewportSignature;

    if (changed) {
      generation += 1;
      currentViewportSignature = nextSignature;
      reserveKeys = new Set();
    }

    const estimatedFullBytes = rawBytesFor(frames, chunks);
    const targets =
      fullForPlay && estimatedFullBytes <= FULL_LOOP_CAP_BYTES
        ? frames
        : rollingFrames(frames);

    // Load the exact currently displayed frame for the new viewport before
    // exposing the new chunk set, so zooming/panning never falls back to a
    // second radar quality.
    const anchor = frames[anchorIndex(frames)];
    if (changed && anchor) {
      await preload([anchor], chunks, { progress: false });
      if (generation < 0) return false;
      baseSetVisible?.call(nativeLayer, chunks.map(chunk => String(chunk.id)));
    } else if (!nativeLayer.visibleIds?.length) {
      baseSetVisible?.call(nativeLayer, chunks.map(chunk => String(chunk.id)));
    }

    baseSetEnabled?.call(nativeLayer, true);

    const ready = await preload(targets, chunks, { progress });
    syncNativeToClock();

    console.info(
      "MRALA v24 native-only preload:",
      `${targets.length}/${frames.length} target frame(s)`,
      `• ${chunks.length} chunks/frame`,
      `• full loop ${(estimatedFullBytes / 1048576).toFixed(0)} MiB`,
      estimatedFullBytes <= FULL_LOOP_CAP_BYTES ? "• full-loop capable" : "• rolling native mode"
    );

    return ready;
  }

  function scheduleRefresh(delay = 120) {
    if (!map) return;
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      refreshViewport({ fullForPlay: isPlaying(), progress: false }).catch(error =>
        console.warn("MRALA v24 viewport refresh failed", error)
      );
    }, Math.max(0, delay));
  }

  // Capture the manifest before the page's core renderer consumes it.
  const previousFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const response = await previousFetch(input, init);
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (response.ok && MANIFEST_RE.test(url)) {
      try {
        manifest = await response.clone().json();
        scheduleRefresh(0);
      } catch (error) {
        console.warn("MRALA v24 manifest capture failed", error);
      }
    }
    return response;
  };

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeSingleSourceClockPatched) {
      layer.__zwxNativeSingleSourceClockPatched = true;
      overviewLayer = layer;
      map = layer.map || map;

      // The overview object remains only because the core player uses it as a
      // timeline clock. It never downloads or renders overview radar data.
      layer.hasTexture = function(key) {
        if (isOverviewKey(key)) return true;
        return false;
      };

      layer.activate = function(key) {
        this.activeKey = String(key);
        this.nextKey = "";
        this.mixAmount = 0;
        syncNativeToClock();
        scheduleRefresh(0);
        this.map?.triggerRepaint?.();
        return true;
      };

      layer.setBlend = function(fromKey, toKey, amount) {
        this.activeKey = String(fromKey);
        this.nextKey = String(toKey);
        this.mixAmount = Math.max(0, Math.min(1, Number(amount) || 0));
        syncNativeToClock();
        scheduleRefresh(0);
        this.map?.triggerRepaint?.();
        return true;
      };

      layer.render = function() {};
      layer.evictExcept = function() {};
      layer.trimTo = function() {};
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxNativeSingleSourceLayerPatched) {
      layer.__zwxNativeSingleSourceLayerPatched = true;
      nativeLayer = layer;
      map = layer.map || map;

      baseSetVisible = layer.setVisible;
      baseSetEnabled = layer.setEnabled;
      baseAddTexture = layer.addTexture;
      baseActivateFrame = layer.activateFrame;
      baseSetBlendFrames = layer.setBlendFrames;
      baseEvictExcept = layer.evictExcept;

      layer.setEnabled = function() {
        return baseSetEnabled?.call(this, true);
      };

      layer.setVisible = function(ids) {
        // Ignore the core overview-mode request to clear native chunks. v24 is
        // the sole radar renderer and owns viewport changes itself.
        if (!ids?.length) return;
        return baseSetVisible?.call(this, ids);
      };

      layer.evictExcept = function(keep) {
        const combined = new Set(keep || []);
        for (const key of reserveKeys) combined.add(key);
        return baseEvictExcept?.call(this, combined);
      };

      baseSetEnabled?.call(layer, true);
      scheduleRefresh(0);

      map?.on?.("zoomend", () => scheduleRefresh(0));
      map?.on?.("moveend", () => scheduleRefresh(0));
    }

    return result;
  };

  // On Play, preload the full visible native loop whenever it fits the safety
  // cap. Wide views that exceed it still use native-only data with an 8-frame
  // rolling runway; no low-resolution radar dataset is ever requested.
  document.addEventListener(
    "click",
    event => {
      const button = event.target?.closest?.("#playPause");
      if (!button || bypassPlayGate || isPlaying() || !nativeLayer || !manifest) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      button.disabled = true;
      const originalText = button.textContent || "▶ Play";

      refreshViewport({ fullForPlay: true, progress: true })
        .catch(error => console.warn("MRALA v24 Play preload failed", error))
        .finally(() => {
          button.disabled = false;
          button.textContent = originalText;
          bypassPlayGate = true;
          button.click();
          bypassPlayGate = false;
        });
    },
    true
  );

  window.__ZWX_MRALA_NATIVE_SINGLE_SOURCE_STATE__ = () => {
    const frames = timelineFrames();
    const chunks = visibleChunks();
    return {
      active: Boolean(nativeLayer),
      frames: frames.length,
      viewportChunks: chunks.length,
      visibleChunkIds: (nativeLayer?.visibleIds || []).map(String),
      nativeTextures: Number(nativeLayer?.textures?.size || 0),
      estimatedFullLoopMiB: Number((rawBytesFor(frames, chunks) / 1048576).toFixed(1)),
      fullLoopFitsCap: rawBytesFor(frames, chunks) <= FULL_LOOP_CAP_BYTES,
      overviewTextures: Number(overviewLayer?.textures?.size || 0),
      overviewIsVirtualClockOnly: Boolean(overviewLayer)
    };
  };

  console.info(
    "MRALA v24: desktop single-source native mode active • overview radar downloads/rendering disabled • one native renderer at every zoom"
  );
})();