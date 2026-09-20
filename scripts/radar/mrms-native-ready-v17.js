(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_READY_V17__) return;
  window.__ZWX_MRALA_NATIVE_READY_V17__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // This is intentionally much smaller than the whole 3-hour archive.
  // It simply moves the selected-speed runway load to the idle period so Play
  // starts from a genuinely ready native buffer instead of building it after
  // playback has already begun.
  const DEPTH_BY_SPEED = new Map([
    ["0.5×", MOBILE ? 2 : 3],
    ["1×", MOBILE ? 3 : 4],
    ["1.5×", MOBILE ? 4 : 5],
    ["2×", MOBILE ? 4 : 5]
  ]);

  const FETCH_CONCURRENCY = MOBILE ? 2 : 4;
  const UPLOAD_BATCH = MOBILE ? 1 : 2;
  const IDLE_DELAY_MS = MOBILE ? 320 : 220;
  const CAMERA_DELAY_MS = MOBILE ? 240 : 160;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxNativeReadyV17Installed) return;
  mapPrototype.__zwxNativeReadyV17Installed = true;

  let nativeLayer = null;
  let overviewLayer = null;
  let timer = 0;
  let busy = false;
  let generation = 0;
  let lastVisibleSignature = "";
  let lastReadySignature = "";
  let resumeTimer = 0;
  let internalPlaybackControl = false;

  const inflight = new Map();

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

  function targetDepth() {
    return DEPTH_BY_SPEED.get(speedLabel()) || (MOBILE ? 3 : 4);
  }

  function manifest() {
    return window.__ZWX_MRALA_RUNTIME_MANIFEST__ || null;
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function timelineFrames() {
    const frames = Array.isArray(manifest()?.frames) ? manifest().frames : [];
    const unavailable = window.__ZWX_MRALA_UNAVAILABLE_FRAME_IDS__ || new Set();
    const valid = frames
      .filter(
        frame =>
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

  function normalizeIds(ids) {
    return [...new Set((ids || []).map(String))].sort();
  }

  function visibleIds(layer = nativeLayer) {
    return normalizeIds(layer?.visibleIds || []);
  }

  function visibleSignature(layer = nativeLayer) {
    return visibleIds(layer).join("|");
  }

  function chunkMap() {
    return new Map(
      (manifest()?.nativeChunking?.layout || []).map(chunk => [
        String(chunk.id),
        chunk
      ])
    );
  }

  function chunksFor(ids) {
    const byId = chunkMap();
    return normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
  }

  function key(frameId, chunkId) {
    return `${frameId}:${chunkId}`;
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(
      manifest()?.nativeChunking?.template ||
      "native-chunks/{frameId}/{chunkId}.dbz"
    )
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));
    return new URL(template, BASE).toString();
  }

  function anchorIndex(frames = timelineFrames()) {
    if (!frames.length) return -1;

    const activeId = String(
      nativeLayer?.toFrame || nativeLayer?.fromFrame || ""
    );
    if (activeId) {
      const index = frames.findIndex(frame => String(frame.id) === activeId);
      if (index >= 0) return index;
    }

    const sliderValue = Math.round(
      Number(document.getElementById("frameSlider")?.value)
    );
    if (!Number.isFinite(sliderValue)) return frames.length - 1;
    return Math.max(0, Math.min(frames.length - 1, sliderValue));
  }

  function startupFrames(depth = targetDepth()) {
    const frames = timelineFrames();
    if (!frames.length) return [];

    const anchor = anchorIndex(frames);
    if (anchor < 0) return [];

    const output = [];
    const seen = new Set();
    let index = anchor;

    // Include the current frame and then the requested number ahead.
    while (output.length < Math.min(depth + 1, frames.length)) {
      if (seen.has(index)) break;
      seen.add(index);
      output.push(frames[index]);
      index = (index + 1) % frames.length;
    }

    return output;
  }

  function complete(frame, chunks) {
    return chunks.every(chunk =>
      nativeLayer?.textures?.has(key(frame.id, chunk.id))
    );
  }

  function readyCount(frames, chunks) {
    let count = 0;
    for (const frame of frames) {
      if (!complete(frame, chunks)) break;
      count += 1;
    }
    return count;
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
      if (!response.ok) throw new Error(`Native startup HTTP ${response.status}`);

      const expected =
        Math.max(1, Number(chunk?.width) || 1) *
        Math.max(1, Number(chunk?.height) || 1);
      const raw = await unpack(await response.arrayBuffer(), expected);
      if (raw.byteLength !== expected) {
        throw new Error(
          `Native startup chunk ${chunk.id} size ${raw.byteLength} != ${expected}`
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

  function yieldToPaint() {
    if (document.hidden || typeof requestAnimationFrame !== "function") {
      return new Promise(resolve => window.setTimeout(resolve, 0));
    }
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  async function loadOneFrame(frame, chunks, localGeneration) {
    const missing = chunks.filter(
      chunk => !nativeLayer.textures?.has(key(frame.id, chunk.id))
    );
    if (!missing.length) return 0;

    const prepared = [];
    let cursor = 0;

    async function worker() {
      while (cursor < missing.length) {
        if (localGeneration !== generation || !nativeLayer?.enabled) return;
        const chunk = missing[cursor++];
        try {
          prepared.push({
            chunk,
            raw: await fetchRaw(frame, chunk)
          });
        } catch (error) {
          console.warn(
            "MRALA v17 startup chunk failed",
            frame?.id,
            chunk?.id,
            error
          );
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(FETCH_CONCURRENCY, Math.max(1, missing.length)) },
        () => worker()
      )
    );

    if (localGeneration !== generation || !nativeLayer?.enabled) return 0;

    let uploaded = 0;
    for (let start = 0; start < prepared.length; start += UPLOAD_BATCH) {
      const batch = prepared.slice(start, start + UPLOAD_BATCH);
      for (const item of batch) {
        const textureKey = key(frame.id, item.chunk.id);
        if (nativeLayer.textures?.has(textureKey)) continue;
        nativeLayer.addTexture(frame.id, item.chunk, item.raw);
        if (nativeLayer.textures?.has(textureKey)) uploaded += 1;
      }
      nativeLayer.map?.triggerRepaint?.();
      if (start + UPLOAD_BATCH < prepared.length) await yieldToPaint();
    }

    return uploaded;
  }

  async function warmStartup() {
    const layer = nativeLayer;
    if (!layer?.enabled || isPlaying() || !manifest()) return false;

    const ids = visibleIds(layer);
    const chunks = chunksFor(ids);
    const frames = startupFrames();
    if (!ids.length || !chunks.length || !frames.length) return false;

    const localGeneration = generation;
    const reserve = new Set();
    for (const frame of frames) {
      for (const chunk of chunks) reserve.add(key(frame.id, chunk.id));
    }

    // Protect the selected-speed startup runway from v15.3's tiny idle trim.
    layer.__zwxStartupReserveKeys = reserve;

    let uploaded = 0;
    for (const frame of frames) {
      if (localGeneration !== generation || !layer.enabled || isPlaying()) break;
      if (!complete(frame, chunks)) {
        uploaded += await loadOneFrame(frame, chunks, localGeneration);
      }
      if (localGeneration === generation && layer.enabled) await yieldToPaint();
    }

    if (localGeneration !== generation || !layer.enabled) return false;

    const ready = readyCount(frames, chunks);
    const signature = `${speedLabel()}:${ids.join("|")}:${ready}:${frames.length}`;
    if (signature !== lastReadySignature || uploaded) {
      lastReadySignature = signature;
      console.info(
        "MRALA v17 ready-before-play:",
        `${ready}/${frames.length} native startup frames resident`,
        `• ${ids.length} chunks/frame`,
        `• ${uploaded} new texture(s)`,
        `• ${speedLabel()}`
      );
    }

    layer.map?.triggerRepaint?.();
    return ready >= frames.length;
  }

  function scheduleWarm(delay = IDLE_DELAY_MS) {
    if (!nativeLayer?.enabled || isPlaying()) return;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      timer = 0;
      if (busy || !nativeLayer?.enabled || isPlaying()) return;
      busy = true;
      try {
        await warmStartup();
      } finally {
        busy = false;
      }
    }, Math.max(0, delay));
  }

  function clearStartupReserve() {
    if (!nativeLayer) return;
    nativeLayer.__zwxStartupReserveKeys = new Set();
  }

  async function pausePrimeResumeForCamera() {
    if (!nativeLayer?.enabled || !isPlaying()) return;
    const button = document.getElementById("playPause");
    if (!button || internalPlaybackControl) return;

    internalPlaybackControl = true;
    try {
      // Native playback should never continue on an unprepared camera region.
      button.click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      scheduleWarm(0);

      const deadline = performance.now() + (MOBILE ? 5000 : 6500);
      while (performance.now() < deadline) {
        if (!busy) {
          busy = true;
          try { await warmStartup(); }
          finally { busy = false; }
        }

        const ids = visibleIds(nativeLayer);
        const chunks = chunksFor(ids);
        const frames = startupFrames();
        if (
          ids.length &&
          chunks.length &&
          frames.length &&
          readyCount(frames, chunks) >= frames.length
        ) {
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 40));
      }

      button.click();
    } finally {
      internalPlaybackControl = false;
    }
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeExclusiveV17Patched) {
      layer.__zwxNativeExclusiveV17Patched = true;
      overviewLayer = layer;
      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function(...renderArgs) {
          // At native zoom during playback there is only one radar renderer.
          // This prevents low-resolution overview motion from showing through
          // when native detail momentarily holds its previous complete frame.
          if (nativeLayer?.enabled && isPlaying()) return;
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id !== NATIVE_ID || layer.__zwxNativeReadyV17Patched) {
      return result;
    }

    layer.__zwxNativeReadyV17Patched = true;
    layer.__zwxStartupReserveKeys = new Set();
    nativeLayer = layer;

    const originalEvictExcept = layer.evictExcept;
    if (typeof originalEvictExcept === "function") {
      layer.evictExcept = function(keep) {
        const combined = new Set(keep || []);
        for (const textureKey of this.__zwxStartupReserveKeys || []) {
          combined.add(textureKey);
        }
        return originalEvictExcept.call(this, combined);
      };
    }

    const originalSetVisible = layer.setVisible;
    if (typeof originalSetVisible === "function") {
      layer.setVisible = function(ids) {
        const before = lastVisibleSignature;
        const output = originalSetVisible.call(this, ids);
        const after = visibleSignature(this);
        lastVisibleSignature = after;
        generation += 1;

        if (!this.enabled) return output;

        if (isPlaying() && before && after && before !== after) {
          if (resumeTimer) window.clearTimeout(resumeTimer);
          resumeTimer = window.setTimeout(
            () => pausePrimeResumeForCamera(),
            CAMERA_DELAY_MS
          );
        } else if (!isPlaying()) {
          scheduleWarm();
        }
        return output;
      };
    }

    const originalSetEnabled = layer.setEnabled;
    if (typeof originalSetEnabled === "function") {
      layer.setEnabled = function(enabled) {
        generation += 1;
        const output = originalSetEnabled.call(this, enabled);
        if (enabled && !isPlaying()) {
          lastVisibleSignature = visibleSignature(this);
          scheduleWarm();
        }
        if (!enabled) {
          if (timer) window.clearTimeout(timer);
          timer = 0;
          clearStartupReserve();
        }
        return output;
      };
    }

    window.__ZWX_MRALA_READY_STATE__ = () => {
      const ids = visibleIds(layer);
      const chunks = chunksFor(ids);
      const frames = startupFrames();
      return {
        speed: speedLabel(),
        targetFrames: frames.length,
        readyFrames: readyCount(frames, chunks),
        chunksPerFrame: ids.length,
        playing: isPlaying(),
        nativeExclusiveDuringPlayback: true
      };
    };

    console.info(
      "MRALA v17: selected-speed native runway prewarmed while paused • " +
      "native-only renderer during native playback • camera changes rebuffer before resume"
    );

    scheduleWarm();
    return result;
  };

  window.addEventListener("DOMContentLoaded", () => {
    const speed = document.getElementById("speedSelect");
    speed?.addEventListener("change", () => {
      generation += 1;
      if (!isPlaying()) scheduleWarm(0);
    });

    const play = document.getElementById("playPause");
    play?.addEventListener("click", () => {
      window.setTimeout(() => {
        if (isPlaying()) {
          // v15.3 now owns the rolling runway; no need to pin the whole startup
          // reserve after playback has actually begun.
          clearStartupReserve();
        } else if (nativeLayer?.enabled) {
          generation += 1;
          scheduleWarm(0);
        }
      }, 0);
    });
  }, { once: true });
})();