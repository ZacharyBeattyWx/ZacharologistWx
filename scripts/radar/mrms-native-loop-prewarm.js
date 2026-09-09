(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_VIDEO_BUFFER_MODE__) return;
  window.__ZWX_MRALA_VIDEO_BUFFER_MODE__ = true;

  const ARCHIVE_BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const CHUNK_RE = /\/mrms-native-numeric\/native-chunks\//i;
  const CHUNK_URL_RE = /\/native-chunks\/([^/]+)\/([^/?#]+)\.dbz(?:[?#]|$)/i;
  const CHUNK_LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const HISTORY_MS = 3 * 60 * 60 * 1000;

  // Switch to native MRMS earlier. The small hysteresis zone prevents rapid
  // quality flapping when the camera sits right on the threshold.
  const NATIVE_ENTER_ZOOM = 5.50;
  const OVERVIEW_REENTER_ZOOM = 5.20;

  const MOBILE = window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const DEVICE_MEMORY_GB = Math.max(2, Number(navigator.deviceMemory || 8));

  // Full-loop network preparation is intentionally separate from GPU memory.
  // The whole visible native loop may stay in local RAM, while GPU textures are
  // kept bounded and rotated like a video decoder's frame queue.
  const NATIVE_GPU_BUDGET_BYTES = Math.round(
    (MOBILE
      ? Math.min(256, Math.max(128, DEVICE_MEMORY_GB * 32))
      : Math.min(704, Math.max(384, DEVICE_MEMORY_GB * 88))) * 1048576
  );
  const IDLE_NATIVE_CACHE_BUDGET_BYTES = NATIVE_GPU_BUDGET_BYTES;
  const NATIVE_PREROLL_FRAMES = MOBILE ? 6 : 12;
  const NATIVE_PRELOAD_CONCURRENCY = MOBILE ? 2 : 5;
  const OVERVIEW_PRELOAD_CONCURRENCY = MOBILE ? 2 : 4;

  let manifest = null;
  let overviewPreparedRevision = "";
  let nativeResponseCacheBytes = 0;

  const nativeResponseCache = new Map();
  const pinnedNativeUrls = new Set();
  const missingNativeUrls = new Set();
  const nativeInflight = new Map();

  const previousFetch = window.fetch.bind(window);

  function inputUrl(input) {
    return String(typeof input === "string" ? input : input?.url || "");
  }

  function copyArrayBuffer(buffer) {
    return buffer.slice(0);
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function recentFrames() {
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
        Number.isFinite(frameMs(frame)) &&
        frameMs(frame) >= cutoff
      )
      .sort((a, b) => frameMs(a) - frameMs(b));
  }

  function manifestRevision() {
    return String(
      manifest?.revision ||
      manifest?.generated_at ||
      manifest?.generatedAt ||
      "manifest"
    );
  }

  function trimNativeResponseCache() {
    while (
      nativeResponseCacheBytes > IDLE_NATIVE_CACHE_BUDGET_BYTES &&
      nativeResponseCache.size > 1
    ) {
      let evictUrl = null;

      for (const candidate of nativeResponseCache.keys()) {
        if (!pinnedNativeUrls.has(candidate)) {
          evictUrl = candidate;
          break;
        }
      }

      // During prepared playback all URLs for the current viewport are pinned.
      // Smooth playback wins over the normal idle cache ceiling until the user
      // changes viewport or leaves native detail.
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

    // Refresh insertion order so unpinned material behaves like a small LRU.
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

    let chunkId = match[2];
    try {
      chunkId = decodeURIComponent(chunkId);
    } catch (_) {}

    const chunk = chunkMap().get(String(chunkId));
    if (!chunk) return null;

    const expected = Number(chunk.width || 0) * Number(chunk.height || 0);
    if (!Number.isFinite(expected) || expected <= 0) return null;

    // Code zero is transparent no-data, so the complete overview remains below
    // an unavailable native archive object rather than exposing a broken tile.
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

    if (missingNativeUrls.size <= 5) {
      console.warn(
        "Native chunk unavailable; using overview fallback",
        status,
        url
      );
    } else if (missingNativeUrls.size === 6) {
      console.warn("Additional missing native-chunk warnings suppressed");
    }
  }

  function patchManifest(manifestObject) {
    const overview = manifestObject?.lod?.overview;
    const native = manifestObject?.lod?.native;

    if (overview && native) {
      overview.recommendedMaxZoom = NATIVE_ENTER_ZOOM;
      native.recommendedMinZoom = OVERVIEW_REENTER_ZOOM;
    }

    manifest = manifestObject;
    window.__ZWX_MRALA_RUNTIME_MANIFEST__ = manifestObject;
    return manifestObject;
  }

  window.fetch = async function (input, init) {
    const url = inputUrl(input);

    if (CHUNK_RE.test(url)) {
      const cached = cachedNativeResponse(url);
      if (cached) {
        return responseFromNativeBytes(
          cached,
          missingNativeUrls.has(url)
            ? "missing-overview-fallback"
            : "video-buffer"
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
        const nextManifest = patchManifest(await response.clone().json());
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        headers.delete("etag");

        return new Response(JSON.stringify(nextManifest), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      } catch (error) {
        console.warn("MRALA video-buffer manifest patch failed", error);
        return response;
      }
    }

    if (CHUNK_RE.test(url)) {
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

  function overviewUrl(frame) {
    const relative = String(frame?.overview || "");
    return relative ? new URL(relative, ARCHIVE_BASE).toString() : "";
  }

  async function packedChunkBytes(url) {
    const cached = cachedNativeResponse(url);
    if (cached) return cached;

    if (nativeInflight.has(url)) {
      return nativeInflight.get(url);
    }

    const promise = (async () => {
      const response = await window.fetch(url, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Native preload HTTP ${response.status}`);
      }

      const bytes = await response.arrayBuffer();
      cacheNativeResponse(url, bytes);
      return bytes;
    })();

    nativeInflight.set(url, promise);

    try {
      return await promise;
    } finally {
      if (nativeInflight.get(url) === promise) {
        nativeInflight.delete(url);
      }
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

  async function warmOverviewLoop(onProgress) {
    if (!manifest) {
      return { ready: false, reason: "manifest unavailable" };
    }

    const revision = manifestRevision();
    if (overviewPreparedRevision === revision) {
      return { ready: true, cached: true };
    }

    const frames = recentFrames().filter(frame => frame?.overview);
    const targets = frames
      .map(frame => ({ frame, url: overviewUrl(frame) }))
      .filter(target => target.url);

    if (!targets.length) {
      return { ready: false, reason: "no overview frames" };
    }

    let cursor = 0;
    let completed = 0;
    let failed = 0;

    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++];

        try {
          // Consume the response now so the browser HTTP cache owns the whole
          // overview loop before the timeline starts moving.
          const response = await previousFetch(target.url, { cache: "force-cache" });
          if (!response.ok) {
            throw new Error(`Overview preload HTTP ${response.status}`);
          }
          await response.arrayBuffer();
        } catch (error) {
          failed += 1;
          console.warn("Overview loop preload failed", target.frame?.id, error);
        } finally {
          completed += 1;
          onProgress?.(completed, targets.length);
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(OVERVIEW_PRELOAD_CONCURRENCY, targets.length) },
        () => worker()
      )
    );

    if (failed) {
      return { ready: false, failed };
    }

    overviewPreparedRevision = revision;
    console.info("MRALA overview loop buffered:", targets.length + " frames");

    return { ready: true, frames: targets.length };
  }

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer) return;

  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (
      layer?.id !== CHUNK_LAYER_ID ||
      layer.__zwxVideoBufferPatched
    ) {
      return result;
    }

    layer.__zwxVideoBufferPatched = true;
    layer.__zwxRequestedVisibleIds = [];
    layer.__zwxViewportSignature = "";
    layer.__zwxPreparedSignature = "";
    layer.__zwxPrepareGeneration = 0;
    layer.__zwxPreparePromise = null;
    layer.__zwxRequestedEnabled = Boolean(layer.enabled);
    layer.__zwxPinnedLoopKeys = new Set();
    layer.__zwxBypassPlayGate = false;
    layer.__zwxResumeAfterMove = false;
    layer.__zwxResumeTimer = 0;

    const map = this;
    const originalSetVisible = layer.setVisible;
    const originalSetEnabled = layer.setEnabled;
    const originalEvictExcept = layer.evictExcept;

    function invalidateNativePreparation(instance) {
      instance.__zwxPrepareGeneration += 1;
      instance.__zwxPreparedSignature = "";
      instance.__zwxPreparePromise = null;
      instance.__zwxPinnedLoopKeys.clear();

      pinnedNativeUrls.clear();
      trimNativeResponseCache();
    }

    layer.setVisible = function (ids) {
      const nextIds = [...new Set((ids || []).map(String))];
      const nextSignature = signatureFor(nextIds);

      this.__zwxRequestedVisibleIds = nextIds;

      if (nextSignature !== this.__zwxViewportSignature) {
        this.__zwxViewportSignature = nextSignature;
        invalidateNativePreparation(this);
      }

      return originalSetVisible.call(this, nextIds);
    };

    layer.setEnabled = function (enabled) {
      const requested = Boolean(enabled);
      this.__zwxRequestedEnabled = requested;

      if (!requested) {
        invalidateNativePreparation(this);
      }

      return originalSetEnabled.call(this, requested);
    };

    layer.evictExcept = function (keep) {
      if (!this.__zwxPinnedLoopKeys.size) {
        return originalEvictExcept.call(this, keep);
      }

      const combined = new Set(keep || []);
      for (const key of this.__zwxPinnedLoopKeys) {
        combined.add(key);
      }

      return originalEvictExcept.call(this, combined);
    };

    layer.__zwxWarmVisibleLoop = async function (onProgress) {
      const ids = [...this.__zwxRequestedVisibleIds];
      const signature = signatureFor(ids);

      if (!this.__zwxRequestedEnabled || !ids.length || !manifest) {
        return { ready: false, reason: "native viewport unavailable" };
      }

      if (this.__zwxPreparedSignature === signature) {
        return { ready: true, cached: true };
      }

      if (this.__zwxPreparePromise) {
        return this.__zwxPreparePromise;
      }

      const generation = this.__zwxPrepareGeneration;
      const byId = chunkMap();
      const chunks = ids.map(id => byId.get(id)).filter(Boolean);
      const frames = recentFrames().filter(frame => frame?.nativeChunksReady);

      if (!chunks.length || !frames.length) {
        return { ready: false, reason: "no native chunks or frames" };
      }

      const bytesPerFrame = chunks.reduce(
        (sum, chunk) =>
          sum + Number(chunk.width || 0) * Number(chunk.height || 0),
        0
      );

      const fullGpuBytes = bytesPerFrame * frames.length;
      const gpuFrameLimit = Math.max(
        1,
        Math.min(
          frames.length,
          Math.floor(NATIVE_GPU_BUDGET_BYTES / Math.max(1, bytesPerFrame))
        )
      );

      const fullGpuResident = gpuFrameLimit >= frames.length;

      // If the whole loop does not safely fit in VRAM, only prepare a modest
      // GPU preroll. The rest is already local and can rotate into the GPU ring
      // without touching CloudFront during playback.
      const gpuPreloadCount = fullGpuResident
        ? frames.length
        : Math.min(gpuFrameLimit, NATIVE_PREROLL_FRAMES);

      let playbackStartIndex = frames.findIndex(
        frame => String(frame.id) === String(this.fromFrame || "")
      );

      // The core player jumps from the newest frame back to frame zero before
      // starting a new loop, so prepare from the oldest frame in that case.
      if (playbackStartIndex < 0 || playbackStartIndex === frames.length - 1) {
        playbackStartIndex = 0;
      }

      const orderedFrames = [
        ...frames.slice(playbackStartIndex),
        ...frames.slice(0, playbackStartIndex)
      ];

      const gpuFrameIds = new Set(
        orderedFrames
          .slice(0, gpuPreloadCount)
          .map(frame => String(frame.id))
      );

      const targets = [];
      for (const frame of orderedFrames) {
        for (const chunk of chunks) {
          const url = nativeChunkUrl(frame.id, chunk.id);
          targets.push({ frame, chunk, url });
        }
      }

      pinnedNativeUrls.clear();
      for (const target of targets) {
        pinnedNativeUrls.add(target.url);
      }

      let cursor = 0;
      let completed = 0;
      let failed = 0;
      const temporaryGpuPins = new Set();
      const startupGpuPins = new Set();
      const started = performance.now();

      this.__zwxPinnedLoopKeys = temporaryGpuPins;

      const promise = (async () => {
        const worker = async () => {
          while (cursor < targets.length) {
            if (generation !== this.__zwxPrepareGeneration) return;

            const target = targets[cursor++];

            try {
              const packed = await packedChunkBytes(target.url);

              if (gpuFrameIds.has(String(target.frame.id))) {
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

                temporaryGpuPins.add(key);

                const startupFrames = orderedFrames.slice(
                  0,
                  Math.min(2, gpuPreloadCount)
                );

                if (
                  startupFrames.some(
                    frame => String(frame.id) === String(target.frame.id)
                  )
                ) {
                  startupGpuPins.add(key);
                }
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
              onProgress?.(completed, targets.length, fullGpuResident);
            }
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(NATIVE_PRELOAD_CONCURRENCY, targets.length) },
            () => worker()
          )
        );

        if (
          generation !== this.__zwxPrepareGeneration ||
          signature !== this.__zwxViewportSignature
        ) {
          return { ready: false, reason: "viewport changed" };
        }

        if (failed) {
          return { ready: false, failed };
        }

        this.__zwxPinnedLoopKeys = fullGpuResident
          ? temporaryGpuPins
          : startupGpuPins;
        this.__zwxPreparedSignature = signature;
        this.map?.triggerRepaint();

        console.info(
          "MRALA native video buffer ready:",
          frames.length + " frames",
          chunks.length + " chunks/frame",
          (nativeResponseCacheBytes / 1048576).toFixed(1) + " MiB local",
          fullGpuResident
            ? "full loop GPU-resident"
            : gpuPreloadCount + "-frame GPU preroll + local full loop",
          Math.round(performance.now() - started) + " ms"
        );

        return {
          ready: true,
          frames: frames.length,
          chunks: chunks.length,
          gpuFrames: gpuPreloadCount,
          fullGpuResident,
          fullGpuBytes,
          localBytes: nativeResponseCacheBytes
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

    async function preparePlayback(instance, button) {
      const overviewResult = await warmOverviewLoop((done, total) => {
        const percent = total ? Math.round(done * 100 / total) : 0;
        if (button) button.textContent = `Buffering radar ${percent}%`;
      });

      if (!overviewResult?.ready) {
        return overviewResult;
      }

      if (!instance.__zwxRequestedEnabled) {
        return { ready: true, tier: "overview" };
      }

      return instance.__zwxWarmVisibleLoop((done, total, fullGpuResident) => {
        const percent = total ? Math.round(done * 100 / total) : 0;
        if (button) {
          button.textContent = fullGpuResident
            ? `Preparing HD ${percent}%`
            : `Buffering HD ${percent}%`;
        }
      });
    }

    window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
    window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missingNativeUrls;

    // If a user pans while the loop is running, pause the clock first. Once the
    // new viewport has been fully prepared from local/network data, resume from
    // the same normal Play pathway. Paused users do not pay for a full-loop
    // preload just because they moved the map.
    map.on("movestart", () => {
      const button = document.getElementById("playPause");
      if (!button) return;

      if (/Pause/i.test(String(button.textContent || ""))) {
        layer.__zwxResumeAfterMove = true;
        button.click();
      }
    });

    map.on("moveend", () => {
      if (!layer.__zwxResumeAfterMove) return;

      window.clearTimeout(layer.__zwxResumeTimer);
      layer.__zwxResumeTimer = window.setTimeout(async () => {
        if (!layer.__zwxResumeAfterMove) return;
        layer.__zwxResumeAfterMove = false;

        const button = document.getElementById("playPause");
        if (!button) return;

        const oldText = button.textContent;
        button.disabled = true;

        try {
          const prepared = await preparePlayback(layer, button);
          if (!prepared?.ready) {
            button.textContent = oldText || "▶ Play";
            return;
          }

          button.disabled = false;
          button.textContent = "▶ Play";
          layer.__zwxBypassPlayGate = true;
          button.click();
        } catch (error) {
          console.warn("MRALA move-resume preparation failed", error);
          button.textContent = oldText || "▶ Play";
        } finally {
          button.disabled = false;
        }
      }, 0);
    });

    console.info(
      "MRALA video-buffer playback enabled • native z" +
        NATIVE_ENTER_ZOOM.toFixed(2) +
        " / exit z" +
        OVERVIEW_REENTER_ZOOM.toFixed(2) +
        " • GPU budget " +
        (NATIVE_GPU_BUDGET_BYTES / 1048576).toFixed(0) +
        " MiB"
    );

    return result;
  };

  window.addEventListener("DOMContentLoaded", () => {
    const playButton = document.getElementById("playPause");
    if (!playButton) return;

    playButton.addEventListener("click", async event => {
      const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
      if (!layer) return;

      // Let the normal handler own Pause immediately.
      if (/Pause/i.test(String(playButton.textContent || ""))) return;

      if (layer.__zwxBypassPlayGate) {
        layer.__zwxBypassPlayGate = false;
        return;
      }

      const overviewReady = overviewPreparedRevision === manifestRevision();
      const nativeReady =
        !layer.__zwxRequestedEnabled ||
        (
          layer.__zwxPreparedSignature &&
          layer.__zwxPreparedSignature === layer.__zwxViewportSignature
        );

      if (overviewReady && nativeReady) {
        return;
      }

      // Quality-over-startup-latency: do not let the playback clock advance
      // until the loop needed by the current view is already local.
      event.preventDefault();
      event.stopImmediatePropagation();

      const oldText = playButton.textContent;
      playButton.disabled = true;

      try {
        const prepared = await (async () => {
          const overviewResult = await warmOverviewLoop((done, total) => {
            const percent = total ? Math.round(done * 100 / total) : 0;
            playButton.textContent = `Buffering radar ${percent}%`;
          });

          if (!overviewResult?.ready) return overviewResult;

          if (!layer.__zwxRequestedEnabled) {
            return { ready: true, tier: "overview" };
          }

          return layer.__zwxWarmVisibleLoop((done, total, fullGpuResident) => {
            const percent = total ? Math.round(done * 100 / total) : 0;
            playButton.textContent = fullGpuResident
              ? `Preparing HD ${percent}%`
              : `Buffering HD ${percent}%`;
          });
        })();

        if (!prepared?.ready) {
          playButton.textContent = oldText || "▶ Play";
          return;
        }

        playButton.disabled = false;
        playButton.textContent = "▶ Play";
        layer.__zwxBypassPlayGate = true;
        playButton.click();
      } catch (error) {
        console.warn("MRALA video-buffer preparation failed", error);
        playButton.textContent = oldText || "▶ Play";
      } finally {
        playButton.disabled = false;
      }
    }, true);
  }, { once: true });
})();
