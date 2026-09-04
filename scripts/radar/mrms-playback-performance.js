(() => {
  "use strict";

  const MOBILE_DEVICE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const GPU_FRAME_CACHE_LIMIT = MOBILE_DEVICE ? 3 : 5;
  const INSTALL_TIMEOUT_MS = 20000;
  const FACTORY_RETRY_MS = 8;
  const RUNTIME_RETRY_MS = 30;
  const NATIVE_RETRY_MS = 60;
  const startedAt = Date.now();

  let factoryPatched = false;
  let runtimePatched = false;
  let nativePatched = false;

  function frameKeySafe(frame) {
    try {
      if (typeof frameKey === "function") return String(frameKey(frame));
    } catch (_) {}
    return String(frame?.id || frame?.valid_time || frame?.image || "");
  }

  function normalizeIndex(index) {
    if (!Array.isArray(frames) || !frames.length) return 0;
    return ((Number(index) % frames.length) + frames.length) % frames.length;
  }

  function speed() {
    try {
      return Math.max(0.5, Number(speedSelect?.value) || 1);
    } catch (_) {
      return 1;
    }
  }

  function baseBufferCount() {
    const value = speed();
    if (value >= 2) return MOBILE_DEVICE ? 3 : 5;
    if (value >= 1.5) return MOBILE_DEVICE ? 3 : 4;
    if (value >= 1) return MOBILE_DEVICE ? 3 : 4;
    return MOBILE_DEVICE ? 2 : 3;
  }

  function nativeRequiredCount() {
    const value = speed();
    if (value >= 2) return MOBILE_DEVICE ? 4 : 6;
    if (value >= 1.5) return MOBILE_DEVICE ? 4 : 5;
    if (value >= 1) return MOBILE_DEVICE ? 3 : 4;
    return MOBILE_DEVICE ? 2 : 3;
  }

  function configureTexture(gl, texture) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Overview is a display LOD. Smooth the coarse national pixels here while
    // native-detail chunks retain their sharper nearest-neighbor sampling.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  function sourceWidth(source) {
    return Number(source?.width || source?.naturalWidth || 0);
  }

  function sourceHeight(source) {
    return Number(source?.height || source?.naturalHeight || 0);
  }

  function patchLayer(layer) {
    if (!layer || layer.__zwxGpuRingPatched) return layer;
    layer.__zwxGpuRingPatched = true;
    layer.__zwxFrameTextures = new Map();
    layer.__zwxActiveFrameKey = "";

    const originalOnAdd = layer.onAdd?.bind(layer);
    const originalOnRemove = layer.onRemove?.bind(layer);
    const originalSetImage = layer.setImage?.bind(layer);

    function touch(key) {
      const entry = layer.__zwxFrameTextures.get(key);
      if (entry) entry.used = performance.now();
      return entry;
    }

    function evict() {
      if (!layer.gl) return;
      const cache = layer.__zwxFrameTextures;
      if (cache.size <= GPU_FRAME_CACHE_LIMIT) return;

      const removable = [...cache.entries()]
        .filter(([key]) => key !== layer.__zwxActiveFrameKey)
        .sort((a, b) => a[1].used - b[1].used);

      while (cache.size > GPU_FRAME_CACHE_LIMIT && removable.length) {
        const [key, entry] = removable.shift();
        if (entry?.texture) layer.gl.deleteTexture(entry.texture);
        cache.delete(key);
      }
    }

    function uploadTexture(key, image) {
      if (!layer.gl || !image || !key) return null;
      const existing = touch(key);
      if (existing) return existing;

      const width = sourceWidth(image);
      const height = sourceHeight(image);
      if (!width || !height) return null;

      const gl = layer.gl;
      const texture = gl.createTexture();
      configureTexture(gl, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== undefined) {
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image
      );

      const entry = {
        texture,
        width,
        height,
        used: performance.now()
      };
      layer.__zwxFrameTextures.set(key, entry);
      evict();
      return entry;
    }

    function seedCurrentTexture(gl) {
      if (!gl || !layer.texture) return;
      configureTexture(gl, layer.texture);
      let key = "__initial__";
      try {
        if (typeof currentFrameKey === "function") {
          key = String(currentFrameKey() || key);
        }
      } catch (_) {}
      layer.__zwxActiveFrameKey = key;
      layer.__zwxFrameTextures.set(key, {
        texture: layer.texture,
        width: Number(layer.textureWidth || 0),
        height: Number(layer.textureHeight || 0),
        used: performance.now()
      });
    }

    layer.onAdd = function(mapRef, gl) {
      originalOnAdd?.(mapRef, gl);
      seedCurrentTexture(gl);
    };

    layer.preloadFrame = function(key, image) {
      return Boolean(uploadTexture(String(key || ""), image));
    };

    layer.activateFrame = function(key, image) {
      const normalizedKey = String(key || "");
      let entry = touch(normalizedKey);
      if (!entry && image) entry = uploadTexture(normalizedKey, image);
      if (!entry) return false;

      this.texture = entry.texture;
      this.textureWidth = entry.width;
      this.textureHeight = entry.height;
      this.textureInitialized = true;
      this.__zwxActiveFrameKey = normalizedKey;
      entry.used = performance.now();
      evict();
      this.map?.triggerRepaint();
      return true;
    };

    layer.isFramePreloaded = function(key) {
      return this.__zwxFrameTextures.has(String(key || ""));
    };

    layer.setImage = function(image) {
      const targetKey = String(window.__ZWX_MRMS_GPU_TARGET_KEY || "");
      if (targetKey && this.activateFrame(targetKey, image)) return;
      originalSetImage?.(image);
      if (this.texture && this.gl) configureTexture(this.gl, this.texture);
    };

    // If the layer was already added before this shim arrived, seed its current
    // texture immediately so the optimization is still effective.
    if (layer.gl && layer.texture) seedCurrentTexture(layer.gl);

    layer.onRemove = function(mapRef, gl) {
      const activeTexture = this.texture;
      originalOnRemove?.(mapRef, gl);
      for (const entry of this.__zwxFrameTextures.values()) {
        if (entry?.texture && entry.texture !== activeTexture) {
          try { gl.deleteTexture(entry.texture); } catch (_) {}
        }
      }
      this.__zwxFrameTextures.clear();
    };

    return layer;
  }

  function patchFactory() {
    if (factoryPatched) return true;
    try {
      if (typeof createPythonColoredRadarLayer !== "function") return false;
      const originalFactory = createPythonColoredRadarLayer;
      createPythonColoredRadarLayer = function(...args) {
        return patchLayer(originalFactory(...args));
      };
      factoryPatched = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function preloadBaseFrame(index) {
    if (!Array.isArray(frames) || !frames.length || !radarLayer?.preloadFrame) {
      return false;
    }
    const normalized = normalizeIndex(index);
    const frame = frames[normalized];
    if (!frame) return false;
    const key = frameKeySafe(frame);
    if (!key) return false;
    if (radarLayer.isFramePreloaded?.(key)) return true;
    const source = await loadFrameSource(frame);
    return Boolean(radarLayer.preloadFrame(key, source));
  }

  function patchRuntime() {
    if (runtimePatched) return true;
    try {
      if (
        typeof showFrame !== "function" ||
        typeof primePlaybackBuffer !== "function" ||
        typeof warmAround !== "function" ||
        typeof loadFrameSource !== "function" ||
        typeof speedSelect === "undefined"
      ) {
        return false;
      }

      try {
        if (typeof radarLayer !== "undefined" && radarLayer) patchLayer(radarLayer);
      } catch (_) {}

      const originalShowFrame = showFrame;
      showFrame = async function(index, options = {}) {
        let key = "";
        try {
          const normalized = normalizeIndex(index);
          key = frameKeySafe(frames?.[normalized]);
        } catch (_) {}

        const previous = window.__ZWX_MRMS_GPU_TARGET_KEY;
        if (key) window.__ZWX_MRMS_GPU_TARGET_KEY = key;
        try {
          return await originalShowFrame(index, options);
        } finally {
          window.__ZWX_MRMS_GPU_TARGET_KEY = previous || "";
        }
      };

      const originalWarmAround = warmAround;
      warmAround = function(index) {
        const result = originalWarmAround(index);
        if (!Array.isArray(frames) || !frames.length) return result;
        const ahead = Math.min(baseBufferCount(), Math.max(0, frames.length - 1));
        for (let offset = 1; offset <= ahead; offset += 1) {
          preloadBaseFrame(index + offset).catch(() => {});
        }
        return result;
      };

      primePlaybackBuffer = async function(startIndex) {
        if (!Array.isArray(frames) || !frames.length) return 0;
        const count = Math.min(baseBufferCount(), frames.length);
        const jobs = [];
        for (let offset = 0; offset < count; offset += 1) {
          jobs.push(preloadBaseFrame(startIndex + offset));
        }
        const results = await Promise.all(jobs);
        warmAround(startIndex);
        return results.filter(Boolean).length;
      };

      speedSelect.addEventListener("change", () => {
        try { warmAround(currentFrameIndex); } catch (_) {}
      });

      runtimePatched = true;
      console.info(
        `MRMS playback performance: GPU overview ring enabled (${GPU_FRAME_CACHE_LIMIT} frames)`
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  function patchNative() {
    if (nativePatched) return true;
    try {
      if (
        typeof overlay === "undefined" ||
        !overlay ||
        typeof overlay.prime !== "function" ||
        typeof overlay.frameReady !== "function" ||
        typeof showFrame !== "function"
      ) {
        return false;
      }

      const originalFetchConcurrency = overlay.fetchConcurrency?.bind(overlay);
      if (originalFetchConcurrency) {
        overlay.fetchConcurrency = function() {
          const base = Number(originalFetchConcurrency()) || 1;
          const value = speed();
          if (value >= 2) return Math.max(base, MOBILE_DEVICE ? 4 : 8);
          if (value >= 1.5) return Math.max(base, MOBILE_DEVICE ? 3 : 6);
          return base;
        };
      }

      const originalPrime = overlay.prime.bind(overlay);
      overlay.prime = async function(startIndex) {
        await originalPrime(startIndex);

        const normalized = normalizeIndex(startIndex);
        const startId = String(frames?.[normalized]?.id || "");
        const ids = [
          startId,
          ...(this.lookaheadFrameIds?.(normalized) || [])
        ].filter(Boolean);
        this.prefetchFrameIds?.(ids);

        const required = Math.min(nativeRequiredCount(), ids.length);
        const deadline = performance.now() + (MOBILE_DEVICE ? 5200 : 4400);
        let readyCount = 0;

        while (performance.now() < deadline) {
          readyCount = 0;
          for (const frameId of ids) {
            if (!this.frameReady(frameId)) break;
            readyCount += 1;
          }
          if (readyCount >= required) return readyCount;
          await new Promise(resolve => window.setTimeout(resolve, 20));
        }
        return readyCount;
      };

      // At higher speeds, if the immediate next observation is still arriving
      // but a nearby prefetched observation is already complete, advance to the
      // complete frame instead of retrying the same timestamp every 200 ms.
      const nativeShowFrame = showFrame;
      showFrame = async function(index, options = {}) {
        if (
          isPlaying &&
          typeof detailMode !== "undefined" &&
          detailMode &&
          overlay &&
          Array.isArray(frames) &&
          frames.length
        ) {
          const requested = normalizeIndex(index);
          const requestedId = String(frames[requested]?.id || "");
          if (requestedId && !overlay.frameReady(requestedId)) {
            overlay.requestFrame?.(requestedId, true);
            const maxSkip = speed() >= 2 ? 4 : speed() >= 1.5 ? 3 : 1;
            for (let offset = 1; offset <= maxSkip; offset += 1) {
              const candidate = normalizeIndex(requested + offset);
              const candidateId = String(frames[candidate]?.id || "");
              if (candidateId && overlay.frameReady(candidateId)) {
                return await nativeShowFrame(candidate, options);
              }
            }
          }
        }
        return await nativeShowFrame(index, options);
      };

      speedSelect?.addEventListener("change", () => {
        try {
          if (typeof detailMode !== "undefined" && detailMode) {
            overlay.prefetchFrameIds?.(
              overlay.lookaheadFrameIds?.(currentFrameIndex) || []
            );
          }
        } catch (_) {}
      });

      nativePatched = true;
      console.info("MRMS playback performance: speed-aware native buffer enabled");
      return true;
    } catch (_) {
      return false;
    }
  }

  function installFactoryLoop() {
    if (patchFactory()) return;
    if (Date.now() - startedAt >= INSTALL_TIMEOUT_MS) {
      console.warn("MRMS playback performance: overview factory hook timed out");
      return;
    }
    window.setTimeout(installFactoryLoop, FACTORY_RETRY_MS);
  }

  function installRuntimeLoop() {
    if (patchRuntime()) return;
    if (Date.now() - startedAt >= INSTALL_TIMEOUT_MS) {
      console.warn("MRMS playback performance: runtime hook timed out");
      return;
    }
    window.setTimeout(installRuntimeLoop, RUNTIME_RETRY_MS);
  }

  function installNativeLoop() {
    if (patchNative()) return;
    if (Date.now() - startedAt >= INSTALL_TIMEOUT_MS) return;
    window.setTimeout(installNativeLoop, NATIVE_RETRY_MS);
  }

  installFactoryLoop();
  installRuntimeLoop();
  installNativeLoop();
})();
