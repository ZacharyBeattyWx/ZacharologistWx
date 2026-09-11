(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_PLAY_ONLY_HD_PRELOAD__) return;
  window.__ZWX_MRALA_PLAY_ONLY_HD_PRELOAD__ = true;

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
  const PRELOAD_CONCURRENCY = MOBILE ? 2 : 5;

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
          missingNativeUrls.has(url) ? "missing-overview-fallback" : "hd-play-cache"
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
        console.warn("MRALA HD preload manifest capture failed", error);
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
        throw new Error(`Native HD preload HTTP ${response.status}`);
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

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer) return;

  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id !== CHUNK_LAYER_ID || layer.__zwxPlayOnlyHdPatched) {
      return result;
    }

    layer.__zwxPlayOnlyHdPatched = true;
    layer.__zwxRequestedVisibleIds = [];
    layer.__zwxViewportSignature = "";
    layer.__zwxPreparedSignature = "";
    layer.__zwxPrepareGeneration = 0;
    layer.__zwxPreparePromise = null;
    layer.__zwxPinnedGpuKeys = new Set();
    layer.__zwxBypassPlayGate = false;

    const originalSetVisible = layer.setVisible;
    const originalSetEnabled = layer.setEnabled;
    const originalEvictExcept = layer.evictExcept;

    layer.setVisible = function (ids) {
      const nextIds = [...new Set((ids || []).map(String))];
      const signature = signatureFor(nextIds);

      this.__zwxRequestedVisibleIds = nextIds;

      if (signature !== this.__zwxViewportSignature) {
        this.__zwxViewportSignature = signature;
        this.__zwxPreparedSignature = "";
        this.__zwxPrepareGeneration += 1;
        this.__zwxPreparePromise = null;

        // Keep the previous prepared cache alive while the user moves.
        // Camera motion must never pause playback or trigger HD loading.
      }

      return originalSetVisible.call(this, nextIds);
    };

    layer.setEnabled = function (enabled) {
      if (!enabled) {
        this.__zwxPreparedSignature = "";
        this.__zwxPrepareGeneration += 1;
        this.__zwxPreparePromise = null;
      }
      return originalSetEnabled.call(this, enabled);
    };

    layer.evictExcept = function (keep) {
      if (!this.__zwxPinnedGpuKeys.size) {
        return originalEvictExcept.call(this, keep);
      }

      const combined = new Set(keep || []);
      for (const key of this.__zwxPinnedGpuKeys) combined.add(key);
      return originalEvictExcept.call(this, combined);
    };

    layer.__zwxPrepareHdForPlay = async function (onProgress) {
      const ids = [...this.__zwxRequestedVisibleIds];
      const signature = signatureFor(ids);

      if (!this.enabled || !ids.length || !manifest) {
        return { ready: false, reason: "HD viewport unavailable" };
      }

      if (this.__zwxPreparedSignature === signature) {
        return { ready: true, cached: true };
      }

      if (this.__zwxPreparePromise) return this.__zwxPreparePromise;

      const generation = this.__zwxPrepareGeneration;
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

      let startIndex = frames.findIndex(
        frame => String(frame.id) === String(this.fromFrame || "")
      );
      if (startIndex < 0 || startIndex === frames.length - 1) startIndex = 0;

      const orderedFrames = [
        ...frames.slice(startIndex),
        ...frames.slice(0, startIndex)
      ];
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
      trimIdleCache();

      const preparedGpuPins = new Set();
      let cursor = 0;
      let completed = 0;
      let failed = 0;
      const started = performance.now();

      this.__zwxPinnedGpuKeys = preparedGpuPins;

      const promise = (async () => {
        const worker = async () => {
          while (cursor < targets.length) {
            if (generation !== this.__zwxPrepareGeneration) return;

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
                      `HD preload ${target.chunk.id} size ${raw.byteLength} != ${expected}`
                    );
                  }

                  this.addTexture(target.frame.id, target.chunk, raw);
                }

                preparedGpuPins.add(key);
              }
            } catch (error) {
              failed += 1;
              console.warn(
                "HD play preload failed",
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
            { length: Math.min(PRELOAD_CONCURRENCY, targets.length) },
            () => worker()
          )
        );

        if (
          generation !== this.__zwxPrepareGeneration ||
          signature !== this.__zwxViewportSignature
        ) {
          return { ready: false, reason: "viewport changed while preparing" };
        }

        if (failed) return { ready: false, failed };

        this.__zwxPinnedGpuKeys = preparedGpuPins;
        this.__zwxPreparedSignature = signature;
        this.map?.triggerRepaint();

        console.info(
          "MRALA HD ready for Play:",
          frames.length + " frames",
          chunks.length + " chunks/frame",
          (nativeCacheBytes / 1048576).toFixed(1) + " MiB local",
          fullGpuResident
            ? "full loop GPU-resident"
            : prerollCount + "-frame GPU preroll pinned + full local loop",
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

    window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
    window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missingNativeUrls;

    console.info(
      "MRALA HD preload: explicit Play only • full GPU preroll retained"
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

      if (layer.__zwxPreparedSignature === layer.__zwxViewportSignature) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const originalText = playButton.textContent;
      playButton.disabled = true;

      try {
        const prepared = await layer.__zwxPrepareHdForPlay(
          (done, total, fullGpuResident) => {
            const percent = total ? Math.round(done * 100 / total) : 0;
            playButton.textContent = fullGpuResident
              ? `Preparing HD ${percent}%`
              : `Loading HD ${percent}%`;
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
        console.warn("MRALA explicit HD Play preparation failed", error);
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
  if (window.__ZWX_MRALA_HD_SYNC_GUARD__) return;
  window.__ZWX_MRALA_HD_SYNC_GUARD__ = true;

  const CHUNK_LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer) return;

  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id !== CHUNK_LAYER_ID || layer.__zwxHdSyncGuardPatched) {
      return result;
    }

    layer.__zwxHdSyncGuardPatched = true;
    layer.__zwxDisplaySuppressed = false;
    layer.__zwxBackgroundWarmTimer = 0;

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

    function scheduleBackgroundWarm(instance) {
      if (!isPlaying() || !instance.enabled) return;

      window.clearTimeout(instance.__zwxBackgroundWarmTimer);
      instance.__zwxBackgroundWarmTimer = window.setTimeout(async () => {
        if (
          !isPlaying() ||
          !instance.enabled ||
          typeof instance.__zwxPrepareHdForPlay !== "function"
        ) {
          return;
        }

        try {
          const prepared = await instance.__zwxPrepareHdForPlay();
          if (prepared?.ready) instance.map?.triggerRepaint();
        } catch (error) {
          console.warn("MRALA silent HD catch-up failed", error);
        }
      }, 0);
    }

    layer.render = function (gl, matrix) {
      if (this.__zwxDisplaySuppressed) return;
      return originalRender.call(this, gl, matrix);
    };

    layer.hasFrame = function (frameId, ids) {
      const ready = originalHasFrame.call(this, frameId, ids);

      if (!ready && isPlaying() && this.enabled) {
        setSuppressed(this, true);
        scheduleBackgroundWarm(this);
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
        scheduleBackgroundWarm(this);
      }

      return result;
    };

    console.info(
      "MRALA HD sync guard: stale native frames suppressed; silent catch-up enabled"
    );

    return result;
  };
})();