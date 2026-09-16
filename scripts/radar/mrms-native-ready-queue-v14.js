(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MOBILE = matchMedia?.("(pointer: coarse)")?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // v14 makes playback a consumer of a prepared GPU queue instead of letting
  // several helpers independently react to every timeline tick.
  const TARGET_QUEUE = MOBILE ? 8 : 24;
  const PLAY_GATE = MOBILE ? 4 : 10;
  const LOAD_CONCURRENCY = MOBILE ? 3 : 8;
  const GPU_BUDGET_BYTES = (MOBILE ? 176 : 320) * 1048576;
  const ACTIVE_BACKGROUND_FRAMES = MOBILE ? 1 : 3;
  const IDLE_RETRY_MS = MOBILE ? 55 : 25;
  const ACTIVE_RETRY_MS = MOBILE ? 35 : 12;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxReadyQueueV14Installed) return;
  mapPrototype.__zwxReadyQueueV14Installed = true;

  let nativeLayer = null;
  let overviewLayer = null;
  let timer = 0;
  let busy = false;
  let pending = false;
  let aggressivePending = false;
  let bypassPlayGate = false;
  let lastLogSignature = "";

  const normalizeIds = ids => [...new Set((ids || []).map(String))].sort();
  const textureKey = (frameId, chunkId) => `${frameId}:${chunkId}`;
  const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  function visibleIds(layer = nativeLayer) {
    return normalizeIds(layer?.__zwxRequestedVisibleIds || layer?.visibleIds || []);
  }

  function isPlaying() {
    return /Pause/i.test(String(document.getElementById("playPause")?.textContent || ""));
  }

  function sliderIndex(frames = timelineFrames()) {
    if (!frames.length) return -1;
    const value = Math.round(Number(document.getElementById("frameSlider")?.value));
    if (!Number.isFinite(value)) return frames.length - 1;
    return Math.max(0, Math.min(frames.length - 1, value));
  }

  function queueCount(ids) {
    const byId = chunkMap();
    const chunks = normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
    const bytesPerFrame = chunks.reduce(
      (sum, chunk) => sum + Number(chunk?.width || 0) * Number(chunk?.height || 0),
      0
    );
    if (!bytesPerFrame) return PLAY_GATE;
    const budgetCount = Math.max(PLAY_GATE, Math.floor(GPU_BUDGET_BYTES / bytesPerFrame));
    return Math.max(PLAY_GATE, Math.min(TARGET_QUEUE, budgetCount));
  }

  function sequentialFrames(count, anchor = sliderIndex()) {
    const frames = timelineFrames();
    if (!frames.length || anchor < 0) return [];

    const output = [];
    const seen = new Set();
    let index = Math.max(0, Math.min(frames.length - 1, anchor));

    while (output.length < Math.min(count, frames.length - 1)) {
      index = (index + 1) % frames.length;
      if (seen.has(index)) break;
      seen.add(index);
      const frame = frames[index];
      if (frame?.nativeChunksReady) output.push(frame);
    }
    return output;
  }

  function chunksFor(ids) {
    const byId = chunkMap();
    return normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(manifest()?.nativeChunking?.template || "native-chunks/{frameId}/{chunkId}.dbz")
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));
    return new URL(template, BASE).toString();
  }

  async function unpack(buffer, expected) {
    if (buffer.byteLength === expected) return new Uint8Array(buffer);
    const probe = new Uint8Array(buffer);
    if (probe[0] === 0x1f && probe[1] === 0x8b && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return probe;
  }

  function cancelLegacyRunway(layer = nativeLayer) {
    if (!layer) return;
    if (layer.__zwxRunwayTimer) {
      clearTimeout(layer.__zwxRunwayTimer);
      layer.__zwxRunwayTimer = 0;
    }
    layer.__zwxRunwayGeneration = Number(layer.__zwxRunwayGeneration || 0) + 1;
    layer.__zwxPinnedGpuKeys = new Set();
    layer.__zwxRunwayFrames = 0;
  }

  function frameComplete(layer, frame, chunks) {
    return chunks.every(chunk => layer.textures?.has(textureKey(frame.id, chunk.id)));
  }

  function readyAhead(layer = nativeLayer) {
    if (!layer?.enabled || !layer.__zwxHdLocked) return 0;
    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!chunks.length) return 0;
    const frames = sequentialFrames(queueCount(ids));
    let ready = 0;
    for (const frame of frames) {
      if (!frameComplete(layer, frame, chunks)) break;
      ready += 1;
    }
    return ready;
  }

  async function ensureTexture(layer, frame, chunk) {
    const key = textureKey(frame.id, chunk.id);
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

  async function loadFrameSet(layer, frames, chunks) {
    const targets = [];
    for (const frame of frames) {
      for (const chunk of chunks) {
        if (!layer.textures?.has(textureKey(frame.id, chunk.id))) {
          targets.push({ frame, chunk });
        }
      }
    }

    let cursor = 0;
    let loaded = 0;
    async function worker() {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        try {
          if (await ensureTexture(layer, target.frame, target.chunk)) loaded += 1;
        } catch {}
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) },
        () => worker()
      )
    );
    return loaded;
  }

  function queuePins(frames, chunks) {
    const pins = new Set();
    for (const frame of frames) {
      for (const chunk of chunks) pins.add(textureKey(frame.id, chunk.id));
    }
    return pins;
  }

  function currentPins(layer, chunks) {
    const pins = new Set();
    for (const frameId of [layer?.fromFrame, layer?.toFrame]) {
      if (!frameId) continue;
      for (const chunk of chunks) pins.add(textureKey(frameId, chunk.id));
    }
    return pins;
  }

  async function fillQueue(aggressive = false) {
    const layer = nativeLayer;
    if (!layer?.enabled || !layer.__zwxHdLocked) return { ready: 0, target: 0 };

    cancelLegacyRunway(layer);

    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!ids.length || !chunks.length) return { ready: 0, target: 0 };

    const count = queueCount(ids);
    const frames = sequentialFrames(count);
    if (!frames.length) return { ready: 0, target: 0 };

    const nextPins = queuePins(frames, chunks);
    const oldPins = new Set(layer.__zwxV14QueueKeys || []);
    layer.__zwxV14QueueKeys = new Set([...oldPins, ...nextPins]);

    const gateFrames = frames.slice(0, Math.min(PLAY_GATE, frames.length));
    const immediateLoaded = await loadFrameSet(layer, gateFrames, chunks);

    const remaining = frames.slice(gateFrames.length);
    const backgroundFrames = aggressive || !isPlaying()
      ? remaining
      : remaining.filter(frame => !frameComplete(layer, frame, chunks)).slice(0, ACTIVE_BACKGROUND_FRAMES);

    const backgroundLoaded = backgroundFrames.length
      ? await loadFrameSet(layer, backgroundFrames, chunks)
      : 0;

    layer.__zwxV14QueueKeys = nextPins;

    const keep = new Set([...nextPins, ...currentPins(layer, chunks)]);
    layer.evictExcept?.(keep);
    layer.map?.triggerRepaint?.();

    let complete = 0;
    for (const frame of frames) {
      if (!frameComplete(layer, frame, chunks)) break;
      complete += 1;
    }

    const signature = `${document.getElementById("frameSlider")?.value || ""}:${ids.join("|")}:${complete}:${count}`;
    if (signature !== lastLogSignature || immediateLoaded || backgroundLoaded) {
      lastLogSignature = signature;
      console.info(
        "MRALA v14 ready queue:",
        complete + "/" + count + " sequential frames GPU-ready",
        "• " + ids.length + " chunks/frame",
        "• uploaded " + immediateLoaded + " gate + " + backgroundLoaded + " background texture(s)",
        complete >= Math.min(PLAY_GATE, frames.length) ? "• playback lane ready" : "• priming playback lane"
      );
    }

    return { ready: complete, target: count };
  }

  function schedule(delay = 0, aggressive = false) {
    if (!nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;
    cancelLegacyRunway(nativeLayer);
    pending = true;
    aggressivePending = aggressivePending || aggressive;
    if (busy || timer) return;

    timer = setTimeout(async () => {
      timer = 0;
      if (busy || !nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;
      busy = true;
      try {
        do {
          pending = false;
          const useAggressive = aggressivePending;
          aggressivePending = false;
          const result = await fillQueue(useAggressive);
          if (result.ready < result.target) {
            pending = true;
            if (isPlaying()) break;
          }
        } while (pending);
      } finally {
        busy = false;
        if (pending) schedule(isPlaying() ? ACTIVE_RETRY_MS : IDLE_RETRY_MS, aggressivePending);
      }
    }, Math.max(0, delay));
  }

  async function primeForPlay() {
    const layer = nativeLayer;
    if (!layer?.enabled || !layer.__zwxHdLocked) return true;

    const ids = visibleIds(layer);
    const needed = Math.min(PLAY_GATE, queueCount(ids));
    if (readyAhead(layer) >= needed) return true;

    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (!busy) {
        busy = true;
        try { await fillQueue(true); }
        finally { busy = false; }
      }
      if (readyAhead(layer) >= needed) return true;
      await sleep(25);
    }
    return readyAhead(layer) >= Math.min(3, needed);
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxV14OverviewPatched) {
      layer.__zwxV14OverviewPatched = true;
      overviewLayer = layer;
      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function (...renderArgs) {
          if (nativeLayer?.enabled && nativeLayer.__zwxHdLocked) return;
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id !== NATIVE_ID || layer.__zwxReadyQueueV14Patched) return result;

    layer.__zwxReadyQueueV14Patched = true;
    nativeLayer = layer;
    layer.__zwxV14QueueKeys = new Set();
    cancelLegacyRunway(layer);

    const originalEvictExcept = layer.evictExcept;
    if (typeof originalEvictExcept === "function") {
      layer.evictExcept = function (keep) {
        const combined = new Set(keep || []);
        for (const key of this.__zwxV14QueueKeys || []) combined.add(key);
        return originalEvictExcept.call(this, combined);
      };
    }

    const originalHasFrame = layer.hasFrame;
    if (typeof originalHasFrame === "function") {
      layer.hasFrame = function (...args) {
        const output = originalHasFrame.apply(this, args);
        cancelLegacyRunway(this);
        if (this.enabled && this.__zwxHdLocked) schedule(0);
        return output;
      };
    }

    const originalSetVisible = layer.setVisible;
    if (typeof originalSetVisible === "function") {
      layer.setVisible = function (...args) {
        const output = originalSetVisible.apply(this, args);
        cancelLegacyRunway(this);
        if (this.enabled && this.__zwxHdLocked) schedule(0, true);
        return output;
      };
    }

    const originalSetEnabled = layer.setEnabled;
    if (typeof originalSetEnabled === "function") {
      layer.setEnabled = function (...args) {
        const output = originalSetEnabled.apply(this, args);
        cancelLegacyRunway(this);
        if (this.enabled && this.__zwxHdLocked) schedule(0, true);
        return output;
      };
    }

    const originalActivateFrame = layer.activateFrame;
    if (typeof originalActivateFrame === "function") {
      layer.activateFrame = function (...args) {
        const output = originalActivateFrame.apply(this, args);
        cancelLegacyRunway(this);
        schedule(0);
        return output;
      };
    }

    const originalSetBlendFrames = layer.setBlendFrames;
    if (typeof originalSetBlendFrames === "function") {
      layer.setBlendFrames = function (...args) {
        const output = originalSetBlendFrames.apply(this, args);
        cancelLegacyRunway(this);
        schedule(0);
        return output;
      };
    }

    layer.map?.on?.("moveend", () => schedule(0, true));
    layer.map?.on?.("zoomend", () => schedule(0, true));

    console.info(
      "MRALA archive player v14: COD-style sequential ready queue • one steady-state GPU owner • no emergency playback guard • up to " +
      TARGET_QUEUE + " native frames prepared ahead"
    );

    return result;
  };

  document.addEventListener("click", event => {
    const button = event.target?.closest?.("#playPause");
    if (!button || bypassPlayGate || isPlaying()) return;
    if (!nativeLayer?.enabled || !nativeLayer.__zwxHdLocked) return;

    const ids = visibleIds(nativeLayer);
    const needed = Math.min(PLAY_GATE, queueCount(ids));
    if (readyAhead(nativeLayer) >= needed) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Preparing…";

    primeForPlay()
      .catch(() => false)
      .finally(() => {
        button.disabled = false;
        button.textContent = originalText;
        bypassPlayGate = true;
        button.click();
        bypassPlayGate = false;
      });
  }, true);
})();