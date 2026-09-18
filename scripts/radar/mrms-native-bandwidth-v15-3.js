(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_BANDWIDTH_V15_3__) return;
  window.__ZWX_MRALA_BANDWIDTH_V15_3__ = true;

  // Keep the core page from starting its legacy native temporal buffer.
  window.__ZWX_MRALA_V14_READY_QUEUE__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Keep the successful v15.2 runway depths. The change in v15.3 is pacing:
  // network/decompression may work ahead, but WebGL uploads are deliberately
  // spread across browser paint opportunities instead of landing in one burst.
  const IDLE_DEPTH = MOBILE ? 1 : 2;
  const PLAY_GATE = MOBILE ? 2 : 3;
  const FETCH_CONCURRENCY = MOBILE ? 3 : 6;
  const FRAME_WAVE = MOBILE ? 2 : 4;
  const UPLOAD_BATCH = MOBILE ? 1 : 2;
  const GPU_BUDGET_BYTES = (MOBILE ? 72 : 144) * 1048576;
  const ACTIVE_RETRY_MS = MOBILE ? 75 : 45;
  const IDLE_RETRY_MS = MOBILE ? 170 : 120;
  const LOG_INTERVAL_MS = MOBILE ? 1400 : 900;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxBandwidthV153Installed) return;
  mapPrototype.__zwxBandwidthV153Installed = true;

  let runtimeManifest = null;
  let nativeLayer = null;
  let timer = 0;
  let busy = false;
  let pending = false;
  let bypassPlayGate = false;
  let generation = 0;
  let lastLogAt = 0;
  let lastLogSignature = "";

  const inflight = new Map();
  const unavailableFrameIds =
    window.__ZWX_MRALA_UNAVAILABLE_FRAME_IDS__ =
      window.__ZWX_MRALA_UNAVAILABLE_FRAME_IDS__ || new Set();
  const originalFetch = window.fetch.bind(window);

  function retireFrameId(frameId, status, source) {
    const id = String(frameId || "");
    if (!id) return false;
    const first = !unavailableFrameIds.has(id);
    unavailableFrameIds.add(id);
    if (first) {
      console.warn(
        "MRALA v15.3 retired unavailable frame",
        id,
        "• HTTP " + status,
        "• " + source
      );
    }
    return first;
  }

  function frameIdFromChunkUrl(url) {
    const match = String(url || "").match(/\/native-chunks\/([^/]+)\//);
    if (!match) return "";
    try { return decodeURIComponent(match[1]); }
    catch { return String(match[1]); }
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function timelineFrames() {
    const frames = Array.isArray(runtimeManifest?.frames)
      ? runtimeManifest.frames
      : [];
    const valid = frames
      .filter(
        frame =>
          frame?.id &&
          !unavailableFrameIds.has(String(frame.id)) &&
          Number.isFinite(frameMs(frame))
      )
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
    return normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
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
    if (label === "2×") return MOBILE ? 6 : 14;
    if (label === "1.5×") return MOBILE ? 5 : 12;
    if (label === "1×") return MOBILE ? 4 : 10;
    return MOBILE ? 3 : 8;
  }

  function sliderIndex(frames = timelineFrames()) {
    if (!frames.length) return -1;

    const activeFrameId = String(
      nativeLayer?.toFrame || nativeLayer?.fromFrame || ""
    );
    if (activeFrameId) {
      const activeIndex = frames.findIndex(
        frame => String(frame?.id || "") === activeFrameId
      );
      if (activeIndex >= 0) return activeIndex;
    }

    const value = Math.round(Number(document.getElementById("frameSlider")?.value));
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
        if (response.status === 403 || response.status === 404) {
          retireFrameId(
            frameIdFromChunkUrl(url),
            response.status,
            "native chunk"
          );
        }
        throw new Error(`Native chunk HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    })();

    inflight.set(url, promise);
    try { return await promise; }
    finally {
      if (inflight.get(url) === promise) inflight.delete(url);
    }
  }

  function yieldToPaint() {
    if (document.hidden || typeof requestAnimationFrame !== "function") {
      return new Promise(resolve => window.setTimeout(resolve, 0));
    }
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  async function prepareTexture(frame, chunk) {
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
    return { frame, chunk, raw, key: chunkKey(frame.id, chunk.id) };
  }

  function frameComplete(layer, frame, chunks) {
    return chunks.every(chunk =>
      layer.textures?.has(chunkKey(frame.id, chunk.id))
    );
  }

  async function loadFrameSet(layer, frames, chunks, localGeneration) {
    const targets = [];
    for (const frame of frames) {
      for (const chunk of chunks) {
        if (!layer.textures?.has(chunkKey(frame.id, chunk.id))) {
          targets.push({ frame, chunk });
        }
      }
    }
    if (!targets.length) return 0;

    // Phase 1: network + decompression. These can overlap without forcing a
    // WebGL upload for every completed response in the same animation frame.
    const prepared = [];
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length) {
        if (localGeneration !== generation || !layer.enabled) return;
        const target = targets[cursor++];
        try {
          if (layer.textures?.has(chunkKey(target.frame.id, target.chunk.id))) {
            continue;
          }
          prepared.push(await prepareTexture(target.frame, target.chunk));
        } catch (error) {
          console.warn(
            "MRALA v15.3 native chunk failed",
            target.frame?.id,
            target.chunk?.id,
            error
          );
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(FETCH_CONCURRENCY, Math.max(1, targets.length)) },
        () => worker()
      )
    );

    if (localGeneration !== generation || !layer.enabled) return 0;

    // Phase 2: upload only a couple textures, give Mapbox/browser a paint,
    // then continue. This is the main-thread pacing pass.
    let uploaded = 0;
    for (let start = 0; start < prepared.length; start += UPLOAD_BATCH) {
      if (localGeneration !== generation || !layer.enabled) break;
      const batch = prepared.slice(start, start + UPLOAD_BATCH);

      for (const item of batch) {
        if (layer.textures?.has(item.key)) continue;
        layer.addTexture(item.frame.id, item.chunk, item.raw);
        if (layer.textures?.has(item.key)) uploaded += 1;
      }

      layer.map?.triggerRepaint?.();
      if (start + UPLOAD_BATCH < prepared.length) {
        await yieldToPaint();
      }
    }

    return uploaded;
  }

  function currentPins(layer, chunks) {
    const pins = new Set();
    for (const frameId of [layer?.fromFrame, layer?.toFrame]) {
      if (!frameId) continue;
      for (const chunk of chunks) pins.add(chunkKey(frameId, chunk.id));
    }
    return pins;
  }

  function readyAhead(layer = nativeLayer, limit = null) {
    if (!layer?.enabled) return 0;
    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!chunks.length) return 0;

    const depth = Math.max(1, Number(limit) || queueDepth(ids, true));
    const frames = upcomingFrames(depth);
    let ready = 0;
    for (const frame of frames) {
      if (!frameComplete(layer, frame, chunks)) break;
      ready += 1;
    }
    return ready;
  }

  function maybeLog(ids, ready, desired, uploaded) {
    const now = performance.now();
    const signature = `${ids.join("|")}:${ready}:${desired}:${isPlaying()}:${speedLabel()}`;
    const completed = ready >= desired;
    const important = completed && signature !== lastLogSignature;
    if (!important && now - lastLogAt < LOG_INTERVAL_MS) return;

    lastLogAt = now;
    lastLogSignature = signature;
    console.info(
      "MRALA v15.3 paced queue:",
      `${ready}/${desired} native frames ahead`,
      `• ${ids.length} chunks/frame`,
      `• ${uploaded} GPU upload(s) this pass`,
      `• upload batch ${UPLOAD_BATCH}`,
      isPlaying() ? `• ${speedLabel()}` : "• idle"
    );
  }

  async function fillQueue({ gateOnly = false } = {}) {
    const layer = nativeLayer;
    if (!layer?.enabled || !runtimeManifest) return { ready: 0, target: 0 };

    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    if (!ids.length || !chunks.length) return { ready: 0, target: 0 };

    const desired = queueDepth(ids, gateOnly ? true : isPlaying());
    if (!upcomingFrames(desired).length) return { ready: 0, target: 0 };

    const localGeneration = generation;
    let uploaded = 0;
    const maxWaves = Math.ceil(desired / FRAME_WAVE) + 1;

    for (let pass = 0; pass < maxWaves; pass += 1) {
      if (localGeneration !== generation || !layer.enabled) break;

      const liveFrames = upcomingFrames(desired);
      const missing = liveFrames.filter(
        frame => !frameComplete(layer, frame, chunks)
      );
      if (!missing.length) break;

      uploaded += await loadFrameSet(
        layer,
        missing.slice(0, FRAME_WAVE),
        chunks,
        localGeneration
      );

      if (gateOnly && readyAhead(layer, desired) >= desired) break;
      if (localGeneration === generation && layer.enabled) {
        await yieldToPaint();
      }
    }

    if (localGeneration !== generation || !layer.enabled) {
      return { ready: 0, target: desired };
    }

    const liveFrames = upcomingFrames(desired);
    const keep = currentPins(layer, chunks);
    for (const frame of liveFrames) {
      for (const chunk of chunks) keep.add(chunkKey(frame.id, chunk.id));
    }

    layer.evictExcept?.(keep);
    layer.map?.triggerRepaint?.();

    const ready = readyAhead(layer, desired);
    maybeLog(ids, ready, desired, uploaded);
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

    const target = queueDepth(ids, true);
    const required = Math.min(target, upcomingFrames(target).length);
    if (!required || readyAhead(layer, required) >= required) return true;

    generation += 1;
    const deadline = performance.now() + (MOBILE ? 5400 : 7200);

    while (performance.now() < deadline) {
      if (!busy) {
        busy = true;
        try { await fillQueue({ gateOnly: true }); }
        finally { busy = false; }
      }
      if (readyAhead(layer, required) >= required) return true;
      await new Promise(resolve => window.setTimeout(resolve, 35));
    }
    return readyAhead(layer, required) >= required;
  }

  // Capture the manifest the core page already requests. No extra poller and
  // no full-history download pass are introduced here.
  window.fetch = async function(input, init) {
    const response = await originalFetch(input, init);
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (response.ok && MANIFEST_RE.test(url)) {
      try {
        runtimeManifest = await response.clone().json();
        window.__ZWX_MRALA_RUNTIME_MANIFEST__ = runtimeManifest;
      } catch (error) {
        console.warn("MRALA v15.3 manifest capture failed", error);
      }
    }
    return response;
  };

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== NATIVE_ID || layer.__zwxBandwidthV153Patched) {
      return result;
    }

    layer.__zwxBandwidthV153Patched = true;
    nativeLayer = layer;

    const originalSetVisible = layer.setVisible;
    if (typeof originalSetVisible === "function") {
      layer.setVisible = function(ids) {
        generation += 1;
        const output = originalSetVisible.call(this, ids);
        if (this.enabled) schedule(MOBILE ? 190 : 130);
        return output;
      };
    }

    const originalSetEnabled = layer.setEnabled;
    if (typeof originalSetEnabled === "function") {
      layer.setEnabled = function(enabled) {
        generation += 1;
        const output = originalSetEnabled.call(this, enabled);
        if (enabled) {
          schedule(MOBILE ? 190 : 130);
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

    layer.map?.on?.("moveend", () => {
      generation += 1;
      if (layer.enabled) schedule(MOBILE ? 150 : 100);
    });

    layer.map?.on?.("zoomend", () => {
      generation += 1;
      if (layer.enabled) schedule(MOBILE ? 150 : 100);
    });

    window.__ZWX_MRALA_NATIVE_PACING_STATE__ = () => ({
      speed: speedLabel(),
      targetDepth: queueDepth(visibleIds(layer), isPlaying()),
      readyAhead: readyAhead(layer),
      chunksPerFrame: visibleIds(layer).length,
      fetchConcurrency: FETCH_CONCURRENCY,
      uploadBatch: UPLOAD_BATCH,
      frameWave: FRAME_WAVE
    });

    console.info(
      "MRALA bandwidth controller v15.3: paced GPU uploads • " +
      FETCH_CONCURRENCY + " fetch/decode workers • " +
      UPLOAD_BATCH + " texture(s) per paint • full speed-aware runway preserved"
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
      const target = queueDepth(ids, true);
      const required = Math.min(target, upcomingFrames(target).length);
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
