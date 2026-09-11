(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_ARCHIVE_PLAYBACK__) return;
  window.__ZWX_MRALA_ARCHIVE_PLAYBACK__ = true;

  const ARCHIVE_BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const CHUNK_RE = /\/mrms-native-numeric\/native-chunks\//i;
  const CHUNK_URL_RE = /\/native-chunks\/[^/]+\/([^/?#]+)\.dbz(?:[?#]|$)/i;
  const CHUNK_LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const HISTORY_MS = 3 * 60 * 60 * 1000;

  const MOBILE = window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const DEVICE_MEMORY_GB = Math.max(2, Number(navigator.deviceMemory || 8));
  const NATIVE_GPU_BUDGET_BYTES = Math.round(
    (MOBILE
      ? Math.min(256, Math.max(128, DEVICE_MEMORY_GB * 32))
      : Math.min(704, Math.max(384, DEVICE_MEMORY_GB * 88))) * 1048576
  );
  const IDLE_CACHE_BUDGET_BYTES = NATIVE_GPU_BUDGET_BYTES;
  const GPU_PREROLL_FRAMES = MOBILE ? 6 : 12;
  const INITIAL_PRELOAD_CONCURRENCY = MOBILE ? 2 : 5;
  const REGION_PREFETCH_CONCURRENCY = MOBILE ? 1 : 3;
  const REGION_GPU_RUNWAY = MOBILE ? 4 : 8;
  const REGION_PREFETCH_DELAY_MS = 30;

  let manifest = null;
  let nativeCacheBytes = 0;

  const nativeCache = new Map();
  const pinnedNativeUrls = new Set();
  const missingNativeUrls = new Set();
  const inflight = new Map();

  const previousFetch = window.fetch.bind(window);

  function inputUrl(input) {
    return String(typeof input === "string" ? input : input?.url || "");
  }

  function cloneBuffer(buffer) {
    return buffer.slice(0);
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function recentNativeFrames() {
    const raw = Array.isArray(manifest?.frames) ? manifest.frames : [];
    if (!raw.length) return [];

    const newest = raw.reduce((value, frame) => {
      const ms = frameMs(frame);
      return Number.isFinite(ms) ? Math.max(value, ms) : value;
    }, 0);
    const cutoff = (newest || Date.now()) - HISTORY_MS;

    return raw
      .filter(frame =>
        frame?.id &&
        frame?.nativeChunksReady &&
        Number.isFinite(frameMs(frame)) &&
        frameMs(frame) >= cutoff
      )
      .sort((a, b) => frameMs(a) - frameMs(b));
  }

  function archiveFramesForLayer(layer) {
    const all = recentNativeFrames();
    if (!layer?.__zwxArchiveFrameIds?.length) return all;
    const wanted = new Set(layer.__zwxArchiveFrameIds.map(String));
    return all.filter(frame => wanted.has(String(frame.id)));
  }

  function chunkMap() {
    return new Map(
      (manifest?.nativeChunking?.layout || []).map(chunk => [String(chunk.id), chunk])
    );
  }

  function nativeChunkUrl(frameId, chunkId) {
    const template = String(
      manifest?.nativeChunking?.template ||
      "native-chunks/{frameId}/{chunkId}.dbz"
    );

    const relative = template
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));

    return new URL(relative, ARCHIVE_BASE).toString();
  }

  function trimIdleCache() {
    while (
      nativeCacheBytes > IDLE_CACHE_BUDGET_BYTES &&
      nativeCache.size > 1
    ) {
      let evictUrl = null;

      for (const candidate of nativeCache.keys()) {
        if (!pinnedNativeUrls.has(candidate)) {
          evictUrl = candidate;
          break;
        }
      }

      if (!evictUrl) break;

      const bytes = nativeCache.get(evictUrl);
      nativeCache.delete(evictUrl);
      nativeCacheBytes -= Number(bytes?.byteLength || 0);
    }
  }

  function cacheBytes(url, bytes) {
    if (!(bytes instanceof ArrayBuffer)) return;

    const existing = nativeCache.get(url);
    if (existing) {
      nativeCacheBytes -= existing.byteLength;
      nativeCache.delete(url);
    }

    nativeCache.set(url, bytes);
    nativeCacheBytes += bytes.byteLength;
    trimIdleCache();
  }

  function cachedBytes(url) {
    const bytes = nativeCache.get(url);
    if (!bytes) return null;

    nativeCache.delete(url);
    nativeCache.set(url, bytes);
    return bytes;
  }

  function fallbackChunkBytes(url) {
    const match = CHUNK_URL_RE.exec(String(url || ""));
    if (!match) return null;

    let chunkId = match[1];
    try {
      chunkId = decodeURIComponent(chunkId);
    } catch (_) {}

    const chunk = chunkMap().get(String(chunkId));
    if (!chunk) return null;

    const expected = Number(chunk.width || 0) * Number(chunk.height || 0);
    if (!Number.isFinite(expected) || expected <= 0) return null;

    return new Uint8Array(expected).buffer;
  }

  function responseFromBytes(bytes, source) {
    return new Response(cloneBuffer(bytes), {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/octet-stream",
        "x-zwx-native-cache": source
      }
    });
  }

  function rememberMissing(url, status) {
    if (missingNativeUrls.has(url)) return;
    missingNativeUrls.add(url);

    if (missingNativeUrls.size <= 5) {
      console.warn("Native chunk unavailable; overview fallback", status, url);
    } else if (missingNativeUrls.size === 6) {
      console.warn("Additional missing native-chunk warnings suppressed");
    }
  }

  window.fetch = async function (input, init) {
    const url = inputUrl(input);

    if (CHUNK_RE.test(url)) {
      const cached = cachedBytes(url);
      if (cached) {
        return responseFromBytes(
          cached,
          missingNativeUrls.has(url)
            ? "missing-overview-fallback"
            : "archive-session-cache"
        );
      }

      if (missingNativeUrls.has(url)) {
        const fallback = fallbackChunkBytes(url);
        if (fallback) {
          cacheBytes(url, fallback);
          return responseFromBytes(fallback, "missing-overview-fallback");
        }
      }
    }

    const response = await previousFetch(input, init);

    if (response.ok && MANIFEST_RE.test(url)) {
      try {
        manifest = await response.clone().json();
        window.__ZWX_MRALA_RUNTIME_MANIFEST__ = manifest;
      } catch (error) {
        console.warn("MRALA archive manifest capture failed", error);
      }
    } else if (CHUNK_RE.test(url)) {
      if (response.ok) {
        response.clone().arrayBuffer().then(bytes => {
          if (!nativeCache.has(url)) cacheBytes(url, bytes);
        }).catch(() => {});
      } else if (response.status === 403 || response.status === 404) {
        const fallback = fallbackChunkBytes(url);
        if (fallback) {
          rememberMissing(url, response.status);
          cacheBytes(url, fallback);
          return responseFromBytes(fallback, "missing-overview-fallback");
        }
      }
    }

    return response;
  };

  async function packedChunkBytes(url) {
    const cached = cachedBytes(url);
    if (cached) return cached;

    if (inflight.has(url)) return inflight.get(url);

    const promise = (async () => {
      const response = await window.fetch(url, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Native archive HTTP ${response.status}`);
      }

      const bytes = await response.arrayBuffer();
      cacheBytes(url, bytes);
      return bytes;
    })();

    inflight.set(url, promise);

    try {
      return await promise;
    } finally {
      if (inflight.get(url) === promise) inflight.delete(url);
    }
  }

  async function maybeDecompress(bytes, expectedLength) {
    if (bytes.byteLength === expectedLength) {
      return new Uint8Array(bytes);
    }

    const probe = new Uint8Array(bytes);
    if (
      probe[0] === 0x1f &&
      probe[1] === 0x8b &&
      typeof DecompressionStream !== "undefined"
    ) {
      const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));

      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    return probe;
  }

  function nativeKey(frameId, chunkId) {
    return String(frameId) + ":" + String(chunkId);
  }

  function signatureFor(ids) {
    return [...new Set((ids || []).map(String))].sort().join("|");
  }

  function orderedFramesFromCurrent(layer, frames) {
    if (!frames.length) return [];

    let startIndex = frames.findIndex(
      frame => String(frame.id) === String(layer?.fromFrame || "")
    );
    if (startIndex < 0 || startIndex === frames.length - 1) startIndex = 0;

    return [
      ...frames.slice(startIndex),
      ...frames.slice(0, startIndex)
    ];
  }

  async function prefetchArchiveRegion(layer, ids, generation) {
    if (
      !layer?.__zwxArchiveSessionActive ||
      !layer.enabled ||
      !ids?.length ||
      !manifest
    ) return;

    const byId = chunkMap();
    const chunks = ids.map(id => byId.get(String(id))).filter(Boolean);
    const frames = archiveFramesForLayer(layer);
    if (!chunks.length || !frames.length) return;

    const orderedFrames = orderedFramesFromCurrent(layer, frames);
    const runwayIds = new Set(
      orderedFrames.slice(0, REGION_GPU_RUNWAY).map(frame => String(frame.id))
    );

    const targets = [];
    for (const frame of orderedFrames) {
      for (const chunk of chunks) {
        targets.push({ frame, chunk, url: nativeChunkUrl(frame.id, chunk.id) });
      }
    }

    let cursor = 0;
    const runwayPins = new Set();

    const worker = async () => {
      while (cursor < targets.length) {
        if (generation !== layer.__zwxRegionPrefetchGeneration) return;

        const target = targets[cursor++];
        try {
          const packed = await packedChunkBytes(target.url);

          if (runwayIds.has(String(target.frame.id))) {
            const key = nativeKey(target.frame.id, target.chunk.id);
            if (!layer.textures.has(key)) {
              const expected =
                Number(target.chunk.width) * Number(target.chunk.height);
              const raw = await maybeDecompress(packed, expected);
              if (raw.byteLength === expected) {
                layer.addTexture(target.frame.id, target.chunk, raw);
              }
            }
            if (layer.textures.has(key)) runwayPins.add(key);
          }
        } catch (error) {
          console.warn(
            "MRALA archive region prefetch failed",
            target.frame?.id,
            target.chunk?.id,
            error
          );
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(REGION_PREFETCH_CONCURRENCY, targets.length) },
        () => worker()
      )
    );

    if (
      generation !== layer.__zwxRegionPrefetchGeneration ||
      !layer.__zwxArchiveSessionActive
    ) return;

    layer.__zwxPinnedGpuKeys = runwayPins;
    layer.map?.triggerRepaint();

    console.info(
      "MRALA archive region ready:",
      frames.length + " archived frames",
      chunks.length + " chunks/frame",
      runwayPins.size + " GPU runway textures",
      (nativeCacheBytes / 1048576).toFixed(1) + " MiB local cache"
    );
  }

  function scheduleArchiveRegionPrefetch(layer, ids) {
    if (!layer?.__zwxArchiveSessionActive || !ids?.length) return;

    const generation = ++layer.__zwxRegionPrefetchGeneration;
    window.clearTimeout(layer.__zwxRegionPrefetchTimer);

    layer.__zwxRegionPrefetchTimer = window.setTimeout(() => {
      prefetchArchiveRegion(layer, [...ids], generation).catch(error => {
        console.warn("MRALA archive region background prefetch failed", error);
      });
    }, REGION_PREFETCH_DELAY_MS);
  }

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer) return;

  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id !== CHUNK_LAYER_ID || layer.__zwxArchivePlaybackPatched) {
      return result;
    }

    layer.__zwxArchivePlaybackPatched = true;
    layer.__zwxRequestedVisibleIds = [];
    layer.__zwxViewportSignature = "";
    layer.__zwxArchiveSessionActive = false;
    layer.__zwxArchiveFrameIds = [];
    layer.__zwxArchiveRevision = "";
    layer.__zwxPreparePromise = null;
    layer.__zwxPinnedGpuKeys = new Set();
    layer.__zwxBypassPlayGate = false;
    layer.__zwxRegionPrefetchGeneration = 0;
    layer.__zwxRegionPrefetchTimer = 0;

    const originalSetVisible = layer.setVisible;
    const originalSetEnabled = layer.setEnabled;
    const originalEvictExcept = layer.evictExcept;

    layer.setVisible = function (ids) {
      const nextIds = [...new Set((ids || []).map(String))];
      const signature = signatureFor(nextIds);
      const changed = signature !== this.__zwxViewportSignature;

      this.__zwxRequestedVisibleIds = nextIds;
      this.__zwxViewportSignature = signature;

      if (changed && this.__zwxArchiveSessionActive) {
        this.__zwxPinnedGpuKeys = new Set();
        pinnedNativeUrls.clear();
        trimIdleCache();
        scheduleArchiveRegionPrefetch(this, nextIds);
      }

      return originalSetVisible.call(this, nextIds);
    };

    layer.setEnabled = function (enabled) {
      const result = originalSetEnabled.call(this, enabled);

      if (enabled && this.__zwxArchiveSessionActive) {
        scheduleArchiveRegionPrefetch(this, this.__zwxRequestedVisibleIds);
      }

      return result;
    };

    layer.evictExcept = function (keep) {
      if (!this.__zwxPinnedGpuKeys.size) {
        return originalEvictExcept.call(this, keep);
      }

      const combined = new Set(keep || []);
      for (const key of this.__zwxPinnedGpuKeys) combined.add(key);
      return originalEvictExcept.call(this, combined);
    };

    layer.__zwxPrepareArchiveForPlay = async function (onProgress) {
      const ids = [...this.__zwxRequestedVisibleIds];

      if (!this.enabled || !ids.length || !manifest) {
        return { ready: false, reason: "HD viewport unavailable" };
      }

      if (this.__zwxArchiveSessionActive) {
        return {
          ready: true,
          cached: true,
          archiveFrames: this.__zwxArchiveFrameIds.length
        };
      }

      if (this.__zwxPreparePromise) return this.__zwxPreparePromise;

      const byId = chunkMap();
      const chunks = ids.map(id => byId.get(id)).filter(Boolean);
      const frames = recentNativeFrames();

      if (!chunks.length || !frames.length) {
        return { ready: false, reason: "no HD chunks or frames" };
      }

      const bytesPerFrame = chunks.reduce(
        (sum, chunk) => sum + Number(chunk.width || 0) * Number(chunk.height || 0),
        0
      );

      const gpuFrameLimit = Math.max(
        1,
        Math.min(
          frames.length,
          Math.floor(NATIVE_GPU_BUDGET_BYTES / Math.max(1, bytesPerFrame))
        )
      );
      const fullGpuResident = gpuFrameLimit >= frames.length;
      const prerollCount = fullGpuResident
        ? frames.length
        : Math.min(gpuFrameLimit, GPU_PREROLL_FRAMES);

      const orderedFrames = orderedFramesFromCurrent(this, frames);
      const prerollIds = new Set(
        orderedFrames.slice(0, prerollCount).map(frame => String(frame.id))
      );

      const targets = [];
      for (const frame of orderedFrames) {
        for (const chunk of chunks) {
          targets.push({
            frame,
            chunk,
            url: nativeChunkUrl(frame.id, chunk.id)
          });
        }
      }

      pinnedNativeUrls.clear();
      for (const target of targets) pinnedNativeUrls.add(target.url);

      const preparedGpuPins = new Set();
      let cursor = 0;
      let completed = 0;
      let failed = 0;
      const started = performance.now();

      this.__zwxPinnedGpuKeys = preparedGpuPins;

      const promise = (async () => {
        const worker = async () => {
          while (cursor < targets.length) {
            const target = targets[cursor++];

            try {
              const packed = await packedChunkBytes(target.url);

              if (prerollIds.has(String(target.frame.id))) {
                const key = nativeKey(target.frame.id, target.chunk.id);

                if (!this.textures.has(key)) {
                  const expected =
                    Number(target.chunk.width) * Number(target.chunk.height);
                  const raw = await maybeDecompress(packed, expected);

                  if (raw.byteLength !== expected) {
                    throw new Error(
                      `Archive preload ${target.chunk.id} size ${raw.byteLength} != ${expected}`
                    );
                  }

                  this.addTexture(target.frame.id, target.chunk, raw);
                }

                preparedGpuPins.add(key);
              }
            } catch (error) {
              failed += 1;
              console.warn(
                "MRALA archive initial preload failed",
                target.frame?.id,
                target.chunk?.id,
                error
              );
            } finally {
              completed += 1;
              onProgress?.(completed, targets.length, fullGpuResident);
            }
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(INITIAL_PRELOAD_CONCURRENCY, targets.length) },
            () => worker()
          )
        );

        if (failed) return { ready: false, failed };

        this.__zwxArchiveSessionActive = true;
        this.__zwxArchiveFrameIds = frames.map(frame => String(frame.id));
        this.__zwxArchiveRevision = String(manifest?.revision || "");
        this.__zwxPinnedGpuKeys = preparedGpuPins;

        pinnedNativeUrls.clear();
        trimIdleCache();

        window.__ZWX_MRALA_ARCHIVE_SESSION__ = {
          revision: this.__zwxArchiveRevision,
          frameIds: [...this.__zwxArchiveFrameIds],
          startedAt: new Date().toISOString()
        };

        this.map?.triggerRepaint();

        console.info(
          "MRALA archive playback ready:",
          frames.length + " frames",
          chunks.length + " initial chunks/frame",
          (nativeCacheBytes / 1048576).toFixed(1) + " MiB local",
          fullGpuResident
            ? "initial viewport full loop GPU-resident"
            : prerollCount + "-frame GPU preroll + full archived viewport cache",
          Math.round(performance.now() - started) + " ms"
        );

        return {
          ready: true,
          frames: frames.length,
          chunks: chunks.length,
          fullGpuResident,
          gpuFrames: prerollCount,
          localBytes: nativeCacheBytes
        };
      })();

      this.__zwxPreparePromise = promise;

      try {
        return await promise;
      } finally {
        if (this.__zwxPreparePromise === promise) {
          this.__zwxPreparePromise = null;
        }
      }
    };

    layer.__zwxPrepareHdForPlay = layer.__zwxPrepareArchiveForPlay;
    layer.__zwxScheduleArchiveRegionPrefetch = ids =>
      scheduleArchiveRegionPrefetch(layer, ids || layer.__zwxRequestedVisibleIds);

    window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
    window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missingNativeUrls;

    console.info(
      "MRALA archive playback: one rolling 3h session • viewport moves do not re-prepare"
    );

    return result;
  };

  window.addEventListener("DOMContentLoaded", () => {
    const playButton = document.getElementById("playPause");
    if (!playButton) return;

    playButton.addEventListener("click", async event => {
      const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;

      if (!layer?.enabled || !layer.__zwxRequestedVisibleIds?.length) return;
      if (/Pause/i.test(String(playButton.textContent || ""))) return;

      if (layer.__zwxBypassPlayGate) {
        layer.__zwxBypassPlayGate = false;
        return;
      }

      if (layer.__zwxArchiveSessionActive) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const originalText = playButton.textContent;
      playButton.disabled = true;

      try {
        const prepared = await layer.__zwxPrepareArchiveForPlay(
          (done, total, fullGpuResident) => {
            const percent = total ? Math.round(done * 100 / total) : 0;
            playButton.textContent = fullGpuResident
              ? `Preparing archive ${percent}%`
              : `Loading archive ${percent}%`;
          }
        );

        if (!prepared?.ready) {
          playButton.textContent = originalText || "▶ Play";
          return;
        }

        playButton.disabled = false;
        playButton.textContent = "▶ Play";
        layer.__zwxBypassPlayGate = true;
        playButton.click();
      } catch (error) {
        console.warn("MRALA archive Play preparation failed", error);
        playButton.textContent = originalText || "▶ Play";
      } finally {
        playButton.disabled = false;
      }
    }, true);
  }, { once: true });
})();

(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_ARCHIVE_SYNC_GUARD__) return;
  window.__ZWX_MRALA_ARCHIVE_SYNC_GUARD__ = true;

  const CHUNK_LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer) return;

  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id !== CHUNK_LAYER_ID || layer.__zwxArchiveSyncGuardPatched) {
      return result;
    }

    layer.__zwxArchiveSyncGuardPatched = true;
    layer.__zwxDisplaySuppressed = false;

    const originalRender = layer.render;
    const originalHasFrame = layer.hasFrame;
    const originalActivateFrame = layer.activateFrame;
    const originalSetBlendFrames = layer.setBlendFrames;
    const originalSetVisible = layer.setVisible;

    const isPlaying = () => /Pause/i.test(
      String(document.getElementById("playPause")?.textContent || "")
    );

    function setSuppressed(instance, suppressed) {
      const next = Boolean(suppressed);
      if (instance.__zwxDisplaySuppressed === next) return;
      instance.__zwxDisplaySuppressed = next;
      instance.map?.triggerRepaint();
    }

    function scheduleRegion(instance) {
      if (
        !instance?.__zwxArchiveSessionActive ||
        !instance.enabled ||
        typeof instance.__zwxScheduleArchiveRegionPrefetch !== "function"
      ) return;

      instance.__zwxScheduleArchiveRegionPrefetch(
        instance.__zwxRequestedVisibleIds
      );
    }

    layer.render = function (gl, matrix) {
      if (this.__zwxDisplaySuppressed) return;
      return originalRender.call(this, gl, matrix);
    };

    layer.hasFrame = function (frameId, ids) {
      const ready = originalHasFrame.call(this, frameId, ids);

      if (!ready && isPlaying() && this.enabled) {
        setSuppressed(this, true);
        scheduleRegion(this);
      }

      return ready;
    };

    layer.activateFrame = function (...activateArgs) {
      const ready = originalActivateFrame.apply(this, activateArgs);
      if (ready) setSuppressed(this, false);
      return ready;
    };

    layer.setBlendFrames = function (...blendArgs) {
      const ready = originalSetBlendFrames.apply(this, blendArgs);
      if (ready) setSuppressed(this, false);
      return ready;
    };

    layer.setVisible = function (ids) {
      const before = String(this.__zwxViewportSignature || "");
      const result = originalSetVisible.call(this, ids);
      const after = String(this.__zwxViewportSignature || "");

      if (isPlaying() && this.enabled && before !== after) {
        setSuppressed(this, true);
        scheduleRegion(this);
      }

      return result;
    };

    console.info(
      "MRALA archive sync: stale HD suppressed • new regions warm silently without playback reset"
    );

    return result;
  };
})();