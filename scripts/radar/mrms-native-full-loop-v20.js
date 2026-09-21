(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_FULL_LOOP_V20__) return;
  window.__ZWX_MRALA_NATIVE_FULL_LOOP_V20__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Desktop can afford a one-time native preload for the current viewport.
  // Mobile keeps the existing rolling native queue to avoid excessive memory.
  const FETCH_CONCURRENCY = MOBILE ? 3 : 8;
  const MAX_DESKTOP_NATIVE_BYTES = 512 * 1048576;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxNativeFullLoopV20Installed) return;
  mapPrototype.__zwxNativeFullLoopV20Installed = true;

  let manifest = null;
  let overviewLayer = null;
  let nativeLayer = null;
  let generation = 0;
  let preloadPromise = null;
  let preloadSignature = "";
  let fullReadySignature = "";
  let bypassPlayGate = false;
  let backgroundTimer = 0;

  const inflight = new Map();

  function isPlaying() {
    return /Pause/i.test(
      String(document.getElementById("playPause")?.textContent || "")
    );
  }

  function normalizeIds(ids) {
    return [...new Set((ids || []).map(String))].sort();
  }

  function visibleIds(layer = nativeLayer) {
    return normalizeIds(layer?.visibleIds || []);
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function timelineFrames() {
    const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
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

  function chunkMap() {
    return new Map(
      (manifest?.nativeChunking?.layout || []).map(chunk => [
        String(chunk.id),
        chunk
      ])
    );
  }

  function chunksFor(ids) {
    const byId = chunkMap();
    return normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
  }

  function textureKey(frameId, chunkId) {
    return `${frameId}:${chunkId}`;
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(
      manifest?.nativeChunking?.template ||
      "native-chunks/{frameId}/{chunkId}.dbz"
    )
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));

    return new URL(template, BASE).toString();
  }

  function viewportSignature(ids = visibleIds()) {
    return normalizeIds(ids).join("|");
  }

  function preloadKey(ids = visibleIds(), frames = timelineFrames()) {
    const newest = String(frames[frames.length - 1]?.id || "");
    return `${viewportSignature(ids)}::${frames.length}::${newest}`;
  }

  function frameComplete(frame, chunks) {
    return chunks.every(chunk =>
      nativeLayer?.textures?.has(textureKey(frame.id, chunk.id))
    );
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
      if (!response.ok) {
        throw new Error(`Native full-loop HTTP ${response.status}`);
      }

      const expected =
        Math.max(1, Number(chunk?.width) || 1) *
        Math.max(1, Number(chunk?.height) || 1);
      const raw = await unpack(await response.arrayBuffer(), expected);
      if (raw.byteLength !== expected) {
        throw new Error(
          `Native full-loop chunk ${chunk.id} size ${raw.byteLength} != ${expected}`
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

  function updateButtonProgress(done, total, originalText) {
    const button = document.getElementById("playPause");
    if (!button || isPlaying()) return;
    button.textContent = total
      ? `Loading native ${done}/${total}…`
      : originalText || "▶ Play";
  }

  function reserveAll(frames, chunks) {
    const reserve = new Set();
    for (const frame of frames) {
      for (const chunk of chunks) {
        reserve.add(textureKey(frame.id, chunk.id));
      }
    }
    nativeLayer.__zwxFullLoopReserveKeys = reserve;
    return reserve;
  }

  function clearReserve() {
    if (nativeLayer) nativeLayer.__zwxFullLoopReserveKeys = new Set();
    fullReadySignature = "";
  }

  async function preloadCurrentViewport({ showProgress = false } = {}) {
    if (MOBILE || !nativeLayer?.enabled || !manifest) return false;

    const ids = visibleIds(nativeLayer);
    const chunks = chunksFor(ids);
    const frames = timelineFrames();
    if (!ids.length || !chunks.length || !frames.length) return false;

    const signature = preloadKey(ids, frames);
    if (
      fullReadySignature === signature &&
      frames.every(frame => frameComplete(frame, chunks))
    ) {
      return true;
    }

    if (preloadPromise && preloadSignature === signature) {
      return preloadPromise;
    }

    const estimatedBytes = rawBytesFor(frames, chunks);
    if (estimatedBytes > MAX_DESKTOP_NATIVE_BYTES) {
      console.warn(
        "MRALA v20 full native preload skipped:",
        `${(estimatedBytes / 1048576).toFixed(0)} MiB exceeds desktop safety cap`,
        `• ${frames.length} frames`,
        `• ${chunks.length} chunks/frame`
      );
      return false;
    }

    const localGeneration = generation;
    preloadSignature = signature;
    reserveAll(frames, chunks);

    const button = document.getElementById("playPause");
    const originalText = button?.textContent || "▶ Play";

    const missingByFrame = new Map();
    const tasks = [];
    let readyFrames = 0;

    for (const frame of frames) {
      const missing = chunks.filter(
        chunk => !nativeLayer.textures?.has(textureKey(frame.id, chunk.id))
      );
      if (!missing.length) {
        readyFrames += 1;
        continue;
      }
      missingByFrame.set(String(frame.id), missing.length);
      for (const chunk of missing) tasks.push({ frame, chunk });
    }

    if (showProgress) updateButtonProgress(readyFrames, frames.length, originalText);

    const run = (async () => {
      let cursor = 0;
      let failed = 0;

      async function worker() {
        while (cursor < tasks.length) {
          if (
            localGeneration !== generation ||
            !nativeLayer?.enabled ||
            viewportSignature(nativeLayer.visibleIds) !== viewportSignature(ids)
          ) {
            return;
          }

          const task = tasks[cursor++];
          const key = textureKey(task.frame.id, task.chunk.id);

          if (nativeLayer.textures?.has(key)) {
            const frameId = String(task.frame.id);
            const left = Math.max(0, (missingByFrame.get(frameId) || 1) - 1);
            missingByFrame.set(frameId, left);
            if (left === 0) {
              readyFrames += 1;
              if (showProgress) {
                updateButtonProgress(readyFrames, frames.length, originalText);
              }
            }
            continue;
          }

          try {
            const raw = await fetchRaw(task.frame, task.chunk);
            if (
              localGeneration !== generation ||
              !nativeLayer?.enabled ||
              viewportSignature(nativeLayer.visibleIds) !== viewportSignature(ids)
            ) {
              return;
            }

            nativeLayer.addTexture(task.frame.id, task.chunk, raw);

            if (nativeLayer.textures?.has(key)) {
              const frameId = String(task.frame.id);
              const left = Math.max(0, (missingByFrame.get(frameId) || 1) - 1);
              missingByFrame.set(frameId, left);
              if (left === 0) {
                readyFrames += 1;
                if (showProgress) {
                  updateButtonProgress(readyFrames, frames.length, originalText);
                }
              }
            } else {
              failed += 1;
            }
          } catch (error) {
            failed += 1;
            console.warn(
              "MRALA v20 native preload chunk failed",
              task.frame?.id,
              task.chunk?.id,
              error
            );
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(FETCH_CONCURRENCY, Math.max(1, tasks.length)) },
          () => worker()
        )
      );

      if (
        localGeneration !== generation ||
        !nativeLayer?.enabled ||
        viewportSignature(nativeLayer.visibleIds) !== viewportSignature(ids)
      ) {
        return false;
      }

      const complete = frames.filter(frame => frameComplete(frame, chunks)).length;
      const allReady = complete === frames.length;

      if (allReady) {
        fullReadySignature = signature;
      }

      console.info(
        "MRALA v20 full native viewport preload:",
        `${complete}/${frames.length} frames resident`,
        `• ${chunks.length} chunks/frame`,
        `• ${(estimatedBytes / 1048576).toFixed(0)} MiB raw GPU target`,
        failed ? `• ${failed} chunk failure(s)` : "• complete"
      );

      nativeLayer.map?.triggerRepaint?.();
      return allReady;
    })();

    preloadPromise = run;
    try {
      return await run;
    } finally {
      if (preloadPromise === run) preloadPromise = null;
      if (showProgress && button && !isPlaying()) {
        button.textContent = originalText;
      }
    }
  }

  function scheduleBackgroundPreload(delay = 250) {
    if (MOBILE || !nativeLayer?.enabled || !isPlaying()) return;
    if (backgroundTimer) window.clearTimeout(backgroundTimer);
    backgroundTimer = window.setTimeout(() => {
      backgroundTimer = 0;
      preloadCurrentViewport({ showProgress: false }).catch(error =>
        console.warn("MRALA v20 background native preload failed", error)
      );
    }, Math.max(0, delay));
  }

  function frameIdFromOverviewKey(key) {
    const text = String(key || "");
    return text.startsWith("overview:")
      ? text.slice("overview:".length)
      : "";
  }

  function nativeMatchesOverview(layer) {
    if (!overviewLayer || !layer?.enabled) return true;

    const ids = visibleIds(layer);
    if (!ids.length) return false;

    const fromId = frameIdFromOverviewKey(overviewLayer.activeKey);
    const nextId = frameIdFromOverviewKey(overviewLayer.nextKey) || fromId;
    if (!fromId) return true;

    const blending =
      Boolean(overviewLayer.nextKey) &&
      Number(overviewLayer.mixAmount || 0) > 0;

    if (!layer.hasFrame?.(fromId, ids)) return false;
    if (blending && !layer.hasFrame?.(nextId, ids)) return false;
    if (String(layer.fromFrame || "") !== fromId) return false;
    if (blending && String(layer.toFrame || "") !== nextId) return false;

    return true;
  }

  // Capture the archive manifest before the other radar shims wrap fetch.
  const previousFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const response = await previousFetch(input, init);
    const url = String(typeof input === "string" ? input : input?.url || "");

    if (response.ok && MANIFEST_RE.test(url)) {
      try {
        manifest = await response.clone().json();
        if (nativeLayer?.enabled && isPlaying()) scheduleBackgroundPreload(50);
      } catch (error) {
        console.warn("MRALA v20 manifest capture failed", error);
      }
    }

    return response;
  };

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID) {
      overviewLayer = layer;
    }

    if (layer?.id !== NATIVE_ID || layer.__zwxNativeFullLoopV20Patched) {
      return result;
    }

    layer.__zwxNativeFullLoopV20Patched = true;
    layer.__zwxFullLoopReserveKeys = new Set();
    nativeLayer = layer;

    // Keep the entire prepared viewport loop resident. v15.3 can still ask to
    // trim to its rolling 5-frame runway, but these reserve keys win until the
    // viewport changes.
    const originalEvictExcept = layer.evictExcept;
    if (typeof originalEvictExcept === "function") {
      layer.evictExcept = function(keep) {
        const combined = new Set(keep || []);
        for (const key of this.__zwxFullLoopReserveKeys || []) {
          combined.add(key);
        }
        return originalEvictExcept.call(this, combined);
      };
    }

    const originalSetVisible = layer.setVisible;
    if (typeof originalSetVisible === "function") {
      layer.setVisible = function(ids) {
        const before = viewportSignature(this.visibleIds);
        const output = originalSetVisible.call(this, ids);
        const after = viewportSignature(this.visibleIds);

        if (before && after && before !== after) {
          generation += 1;
          clearReserve();
          if (isPlaying()) scheduleBackgroundPreload(80);
        } else if (after && this.enabled && isPlaying() && !fullReadySignature) {
          scheduleBackgroundPreload(220);
        }

        return output;
      };
    }

    const originalSetEnabled = layer.setEnabled;
    if (typeof originalSetEnabled === "function") {
      layer.setEnabled = function(enabled) {
        const output = originalSetEnabled.call(this, enabled);
        generation += 1;

        if (enabled && isPlaying()) {
          scheduleBackgroundPreload(120);
        } else if (!enabled) {
          clearReserve();
          if (backgroundTimer) window.clearTimeout(backgroundTimer);
          backgroundTimer = 0;
        }

        return output;
      };
    }

    // Overview is the timeline clock. Native is drawn only when it exactly
    // matches the current overview timestamp/blend, so a camera change or a
    // late native frame never freezes the animation or shows stale radar.
    const originalRender = layer.render;
    if (typeof originalRender === "function") {
      layer.render = function(...renderArgs) {
        if (isPlaying() && !nativeMatchesOverview(this)) return;
        return originalRender.apply(this, renderArgs);
      };
    }

    window.__ZWX_MRALA_FULL_NATIVE_STATE__ = () => {
      const ids = visibleIds(layer);
      const chunks = chunksFor(ids);
      const frames = timelineFrames();
      const complete = frames.filter(frame => frameComplete(frame, chunks)).length;
      return {
        mobile: MOBILE,
        viewportChunks: ids.length,
        frames: frames.length,
        readyFrames: complete,
        fullReady: Boolean(frames.length && complete === frames.length),
        estimatedMiB: Number((rawBytesFor(frames, chunks) / 1048576).toFixed(1)),
        signature: preloadKey(ids, frames)
      };
    };

    console.info(
      MOBILE
        ? "MRALA v20: mobile keeps rolling native queue with overview fallback"
        : "MRALA v20: desktop loads the full visible native 3-hour loop when Play is pressed • overview remains hot as seamless fallback"
    );

    return result;
  };

  // Register before v15.3's capture listener. On desktop/native zoom, one user
  // click means: preload the full visible native loop once, then hand the click
  // back to the normal player. After that, playback is GPU-resident rather than
  // racing a 95ms clock with live network fetches.
  document.addEventListener(
    "click",
    event => {
      const button = event.target?.closest?.("#playPause");
      if (!button || bypassPlayGate || MOBILE || isPlaying()) return;
      if (!nativeLayer?.enabled || !manifest) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      button.disabled = true;
      const originalText = button.textContent || "▶ Play";

      preloadCurrentViewport({ showProgress: true })
        .catch(error => {
          console.warn("MRALA v20 full native preload failed", error);
          return false;
        })
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
})();
