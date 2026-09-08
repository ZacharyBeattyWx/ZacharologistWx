(() => {
  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_LOOP_PREWARM__) return;
  window.__ZWX_MRALA_NATIVE_LOOP_PREWARM__ = true;

  const ARCHIVE_BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const CHUNK_RE = /\/mrms-native-numeric\/native-chunks\//i;
  const CHUNK_URL_RE = /\/native-chunks\/[^/]+\/([^/?#]+)\.dbz(?:[?#]|$)/i;
  const CHUNK_LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const HISTORY_MS = 3 * 60 * 60 * 1000;
  const MOBILE = window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const DEVICE_MEMORY_GB = Math.max(2, Number(navigator.deviceMemory || 8));

  // GPU memory remains bounded. The full current-viewport loop is allowed to
  // stay in the local response cache while playback is armed, so the GPU ring
  // can rotate from local bytes rather than returning to CloudFront mid-loop.
  const NATIVE_GPU_BUDGET_BYTES = Math.round(
    (MOBILE
      ? Math.min(256, Math.max(128, DEVICE_MEMORY_GB * 32))
      : Math.min(704, Math.max(384, DEVICE_MEMORY_GB * 88))) * 1048576
  );
  const IDLE_NETWORK_CACHE_BUDGET_BYTES = NATIVE_GPU_BUDGET_BYTES;
  const PREWARM_CONCURRENCY = MOBILE ? 2 : 5;

  let manifest = null;
  const nativeResponseCache = new Map();
  const pinnedNativeUrls = new Set();
  const missingNativeUrls = new Set();
  let nativeResponseCacheBytes = 0;
  const previousFetch = window.fetch.bind(window);

  function inputUrl(input) {
    return String(typeof input === "string" ? input : input?.url || "");
  }

  function copyArrayBuffer(buffer) {
    return buffer.slice(0);
  }

  function trimNativeResponseCache() {
    while (
      nativeResponseCacheBytes > IDLE_NETWORK_CACHE_BUDGET_BYTES &&
      nativeResponseCache.size > 1
    ) {
      let evictUrl = null;

      for (const candidate of nativeResponseCache.keys()) {
        if (!pinnedNativeUrls.has(candidate)) {
          evictUrl = candidate;
          break;
        }
      }

      // During an armed playback session every byte required by the visible
      // loop may be pinned. In that case we intentionally exceed the idle cache
      // budget until the viewport changes; smooth playback wins over instant
      // startup and fixed-size cache churn.
      if (!evictUrl) break;

      const item = nativeResponseCache.get(evictUrl);
      nativeResponseCache.delete(evictUrl);
      nativeResponseCacheBytes -= Number(item?.byteLength || 0);
    }
  }

  function cacheNativeResponse(url, bytes) {
    if (!(bytes instanceof ArrayBuffer)) return;

    const existing = nativeResponseCache.get(url);
    if (existing) {
      nativeResponseCacheBytes -= existing.byteLength;
      nativeResponseCache.delete(url);
    }

    nativeResponseCache.set(url, bytes);
    nativeResponseCacheBytes += bytes.byteLength;
    trimNativeResponseCache();
  }

  function cachedNativeResponse(url) {
    const bytes = nativeResponseCache.get(url);
    if (!bytes) return null;

    // Refresh insertion order so unpinned idle content behaves like an LRU.
    nativeResponseCache.delete(url);
    nativeResponseCache.set(url, bytes);
    return bytes;
  }

  function chunkMap() {
    return new Map(
      (manifest?.nativeChunking?.layout || []).map(chunk => [String(chunk.id), chunk])
    );
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

    // Code 0 is transparent no-data. The complete overview remains underneath.
    return new Uint8Array(expected).buffer;
  }

  function responseFromNativeBytes(bytes, source) {
    return new Response(copyArrayBuffer(bytes), {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/octet-stream",
        "x-zwx-native-cache": source
      }
    });
  }

  function rememberMissingNative(url, status) {
    if (missingNativeUrls.has(url)) return;
    missingNativeUrls.add(url);

    if (missingNativeUrls.size <= 6) {
      console.warn(
        "Native chunk unavailable; using overview fallback",
        status,
        url
      );
    } else if (missingNativeUrls.size === 7) {
      console.warn("Additional missing native-chunk warnings suppressed for this page load");
    }
  }

  window.fetch = async function (input, init) {
    const url = inputUrl(input);

    if (CHUNK_RE.test(url)) {
      const cached = cachedNativeResponse(url);
      if (cached) {
        return responseFromNativeBytes(
          cached,
          missingNativeUrls.has(url) ? "missing-overview-fallback" : "memory"
        );
      }

      if (missingNativeUrls.has(url)) {
        const fallback = fallbackChunkBytes(url);
        if (fallback) {
          cacheNativeResponse(url, fallback);
          return responseFromNativeBytes(fallback, "missing-overview-fallback");
        }
      }
    }

    const response = await previousFetch(input, init);

    if (response.ok && MANIFEST_RE.test(url)) {
      try {
        manifest = await response.clone().json();
        window.__ZWX_MRALA_RUNTIME_MANIFEST__ = manifest;
      } catch (error) {
        console.warn("MRALA loop preload manifest capture failed", error);
      }
    } else if (CHUNK_RE.test(url)) {
      if (response.ok) {
        response.clone().arrayBuffer().then(bytes => {
          if (!nativeResponseCache.has(url)) {
            cacheNativeResponse(url, bytes);
          }
        }).catch(() => {});
      } else if (response.status === 403 || response.status === 404) {
        const fallback = fallbackChunkBytes(url);
        if (fallback) {
          rememberMissingNative(url, response.status);
          cacheNativeResponse(url, fallback);
          return responseFromNativeBytes(fallback, "missing-overview-fallback");
        }
      }
    }

    return response;
  };

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function recentChunkReadyFrames() {
    const raw = Array.isArray(manifest?.frames) ? manifest.frames : [];
    if (!raw.length) return [];

    const newest = raw.reduce((value, frame) => {
      const ms = frameMs(frame);
      return Number.isFinite(ms) ? Math.max(value, ms) : value;
    }, 0);
    const cutoff = (newest || Date.now()) - HISTORY_MS;

    return raw.filter(frame =>
      frame?.id &&
      frame?.nativeChunksReady &&
      Number.isFinite(frameMs(frame)) &&
      frameMs(frame) >= cutoff
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

  async function packedChunkBytes(url) {
    const cached = cachedNativeResponse(url);
    if (cached) return cached;

    // Use the production wrapper so missing archived objects become a stable
    // transparent fallback instead of a retry storm.
    const response = await window.fetch(url, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`Native preload HTTP ${response.status}`);
    }

    const bytes = await response.arrayBuffer();
    cacheNativeResponse(url, bytes);
    return bytes;
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

    if (
      layer?.id !== CHUNK_LAYER_ID ||
      layer.__zwxFullLoopPrewarmPatched
    ) {
      return result;
    }

    layer.__zwxFullLoopPrewarmPatched = true;
    layer.__zwxRequestedVisibleIds = [];
    layer.__zwxViewportSignature = "";
    layer.__zwxWarmSignature = "";
    layer.__zwxWarmGeneration = 0;
    layer.__zwxLoopWarmPromise = null;
    layer.__zwxLoopWarmReady = false;
    layer.__zwxPinnedLoopKeys = new Set();

    const originalSetVisible = layer.setVisible;
    const originalSetEnabled = layer.setEnabled;
    const originalEvictExcept = layer.evictExcept;

    function invalidateWarmState(instance) {
      instance.__zwxWarmGeneration += 1;
      instance.__zwxLoopWarmReady = false;
      instance.__zwxWarmSignature = "";
      instance.__zwxPinnedLoopKeys.clear();
      instance.__zwxLoopWarmPromise = null;

      // A new viewport gets its own playback gate. Release the previous loop's
      // network pins, then trim old material back to the normal idle budget.
      pinnedNativeUrls.clear();
      trimNativeResponseCache();
    }

    layer.setVisible = function (ids) {
      const nextIds = [...new Set((ids || []).map(String))];
      const nextSignature = signatureFor(nextIds);

      this.__zwxRequestedVisibleIds = nextIds;
      if (nextSignature !== this.__zwxViewportSignature) {
        this.__zwxViewportSignature = nextSignature;
        invalidateWarmState(this);
      }

      return originalSetVisible.call(this, nextIds);
    };

    layer.setEnabled = function (enabled) {
      if (!enabled) {
        invalidateWarmState(this);
      }
      return originalSetEnabled.call(this, enabled);
    };

    layer.evictExcept = function (keep) {
      if (!this.__zwxPinnedLoopKeys.size) {
        return originalEvictExcept.call(this, keep);
      }

      const combined = new Set(keep || []);
      for (const key of this.__zwxPinnedLoopKeys) combined.add(key);
      return originalEvictExcept.call(this, combined);
    };

    layer.__zwxWarmVisibleLoop = async function (onProgress) {
      const ids = [...this.__zwxRequestedVisibleIds];
      const signature = signatureFor(ids);

      if (!this.enabled || !ids.length || !manifest) {
        return { ready: false, reason: "native viewport not ready" };
      }

      if (this.__zwxLoopWarmReady && this.__zwxWarmSignature === signature) {
        return { ready: true, cached: true };
      }

      if (this.__zwxLoopWarmPromise && this.__zwxWarmSignature === signature) {
        return this.__zwxLoopWarmPromise;
      }

      const generation = this.__zwxWarmGeneration;
      const byId = chunkMap();
      const chunks = ids.map(id => byId.get(id)).filter(Boolean);
      const frames = recentChunkReadyFrames();

      if (!chunks.length || !frames.length) {
        return { ready: false, reason: "no native chunks or frames" };
      }

      const bytesPerFrame = chunks.reduce(
        (sum, chunk) => sum + Number(chunk.width || 0) * Number(chunk.height || 0),
        0
      );
      const fullGpuBytes = bytesPerFrame * frames.length;

      // This is adaptive, not a fixed frame count. Small/deep viewports may fit
      // the whole loop in GPU memory; larger ones keep only what the device can
      // safely hold. In either case ALL loop bytes are locally cached first.
      const gpuFrameLimit = Math.max(
        1,
        Math.min(
          frames.length,
          Math.floor(NATIVE_GPU_BUDGET_BYTES / Math.max(1, bytesPerFrame))
        )
      );
      const fullGpuResident = gpuFrameLimit >= frames.length;
      const gpuFrames = new Set(
        frames.slice(0, gpuFrameLimit).map(frame => String(frame.id))
      );

      const targets = [];
      for (const frame of frames) {
        for (const chunk of chunks) {
          const url = nativeChunkUrl(frame.id, chunk.id);
          targets.push({ frame, chunk, url });
        }
      }

      // Pin every object required by THIS viewport before downloading begins.
      // The cache therefore cannot evict the beginning of the loop while it is
      // still downloading the end of the loop.
      pinnedNativeUrls.clear();
      for (const target of targets) pinnedNativeUrls.add(target.url);

      let cursor = 0;
      let completed = 0;
      let failed = 0;
      const pinnedGpu = new Set();
      this.__zwxPinnedLoopKeys = pinnedGpu;
      const started = performance.now();

      const promise = (async () => {
        const worker = async () => {
          while (cursor < targets.length) {
            if (generation !== this.__zwxWarmGeneration) return;

            const target = targets[cursor++];

            try {
              const packed = await packedChunkBytes(target.url);

              if (gpuFrames.has(String(target.frame.id))) {
                const key = nativeKey(target.frame.id, target.chunk.id);
                if (!this.textures.has(key)) {
                  const expected =
                    Number(target.chunk.width) * Number(target.chunk.height);
                  const raw = await maybeDecompress(packed, expected);

                  if (raw.byteLength !== expected) {
                    throw new Error(
                      `Native preload ${target.chunk.id} size ${raw.byteLength} != ${expected}`
                    );
                  }

                  this.addTexture(target.frame.id, target.chunk, raw);
                }
                pinnedGpu.add(key);
              }
            } catch (error) {
              failed += 1;
              console.warn(
                "Native loop preload failed",
                target.frame?.id,
                target.chunk?.id,
                error
              );
            } finally {
              completed += 1;
              if (typeof onProgress === "function") {
                onProgress(completed, targets.length, fullGpuResident);
              }
            }
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(PREWARM_CONCURRENCY, targets.length) },
            () => worker()
          )
        );

        if (
          generation !== this.__zwxWarmGeneration ||
          signature !== this.__zwxViewportSignature
        ) {
          return { ready: false, reason: "viewport changed" };
        }

        this.__zwxPinnedLoopKeys = pinnedGpu;
        this.__zwxWarmSignature = signature;
        this.__zwxLoopWarmReady = failed === 0;
        this.map?.triggerRepaint();

        console.info(
          "MRALA adaptive loop ready:",
          frames.length + " frames",
          chunks.length + " chunks/frame",
          (nativeResponseCacheBytes / 1048576).toFixed(1) + " MiB local loop cache",
          fullGpuResident
            ? "full native loop GPU-resident"
            : gpuFrameLimit + " adaptive GPU frames; remainder local-memory resident",
          Math.round(performance.now() - started) + " ms"
        );

        return {
          ready: failed === 0,
          failed,
          fullGpuResident,
          frames: frames.length,
          gpuFrames: gpuFrameLimit,
          chunks: chunks.length,
          localBytes: nativeResponseCacheBytes
        };
      })();

      this.__zwxWarmSignature = signature;
      this.__zwxLoopWarmPromise = promise;

      try {
        return await promise;
      } finally {
        if (this.__zwxLoopWarmPromise === promise) {
          this.__zwxLoopWarmPromise = null;
        }
      }
    };

    window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
    window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missingNativeUrls;

    console.info(
      "MRALA adaptive playback gate enabled • GPU budget",
      (NATIVE_GPU_BUDGET_BYTES / 1048576).toFixed(0) + " MiB"
    );

    return result;
  };

  window.addEventListener("DOMContentLoaded", () => {
    const playButton = document.getElementById("playPause");
    if (!playButton) return;

    playButton.addEventListener("click", async event => {
      const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
      if (!layer?.enabled || !layer.__zwxRequestedVisibleIds?.length) return;

      // A click while playback is already running is always a Pause request.
      if (/Pause/i.test(String(playButton.textContent || ""))) return;

      if (layer.__zwxBypassWarmClick) {
        layer.__zwxBypassWarmClick = false;
        return;
      }

      if (
        layer.__zwxLoopWarmReady &&
        layer.__zwxWarmSignature === layer.__zwxViewportSignature
      ) {
        return;
      }

      // This is the deliberate quality-over-startup-latency gate: playback is
      // not allowed to begin while the viewport loop is still downloading.
      event.preventDefault();
      event.stopImmediatePropagation();

      const originalText = playButton.textContent;
      playButton.disabled = true;

      try {
        const result = await layer.__zwxWarmVisibleLoop(
          (done, total, fullGpuResident) => {
            const percent = total ? Math.round(done * 100 / total) : 0;
            playButton.textContent = fullGpuResident
              ? `Preparing loop ${percent}%`
              : `Caching loop ${percent}%`;
          }
        );

        if (!result?.ready) {
          playButton.textContent = originalText;
          return;
        }

        playButton.disabled = false;
        playButton.textContent = "▶ Play";
        layer.__zwxBypassWarmClick = true;
        playButton.click();
      } catch (error) {
        console.warn("MRALA adaptive play preload failed", error);
        playButton.textContent = originalText;
      } finally {
        playButton.disabled = false;
      }
    }, true);
  }, { once: true });
})();
