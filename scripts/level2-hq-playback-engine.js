(function () {
  "use strict";

  const DEFAULT_LAYER_ID = "level2-hq-playback-layer";
  const DEFAULT_DOWNLOAD_CONCURRENCY = 3;
  const DEFAULT_DECODE_CONCURRENCY = 2;
  const DEFAULT_BUFFER_AHEAD = 6;
  const DEFAULT_RETRY_COUNT = 2;
  const DEFAULT_RETRY_DELAY_MS = 240;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function frameBounds(frame) {
    const bounds = frame?.bounds;
    if (!Array.isArray(bounds) || bounds.length < 2) return null;

    const south = Number(bounds[0]?.[0]);
    const west = Number(bounds[0]?.[1]);
    const north = Number(bounds[1]?.[0]);
    const east = Number(bounds[1]?.[1]);

    if (![west, south, east, north].every(Number.isFinite)) return null;
    return { west, south, east, north };
  }

  function normalizedIndex(index, length) {
    if (!length) return -1;
    return ((Number(index) % length) + length) % length;
  }

  function closeBitmap(bitmap) {
    if (bitmap && typeof bitmap.close === "function") {
      bitmap.close();
    }
  }

  class Level2HqPlaybackEngine {
    constructor(options = {}) {
      this.map = options.map;
      this.layerId = options.layerId || DEFAULT_LAYER_ID;
      this.beforeLayerId = options.beforeLayerId || (() => undefined);
      this.status = options.status || (() => {});
      this.progress = options.progress || (() => {});
      this.opacity = Number.isFinite(options.opacity) ? options.opacity : 1;

      this.downloadConcurrency = Math.max(
        1,
        Math.floor(options.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY)
      );
      this.decodeConcurrency = Math.max(
        1,
        Math.floor(options.decodeConcurrency ?? DEFAULT_DECODE_CONCURRENCY)
      );
      this.bufferAhead = Math.max(
        2,
        Math.floor(options.bufferAhead ?? DEFAULT_BUFFER_AHEAD)
      );
      this.retryCount = Math.max(
        0,
        Math.floor(options.retryCount ?? DEFAULT_RETRY_COUNT)
      );
      this.retryDelayMs = Math.max(
        0,
        Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
      );

      this.frames = [];
      this.signature = "";
      this.preparedSignature = "";
      this.blobCache = new Map();
      this.bitmapCache = new Map();
      this.decodePromises = new Map();

      this.generation = 0;
      this.abortController = null;
      this.preparing = false;
      this.prepared = false;
      this.active = false;
      this.currentFrameIndex = -1;
      this.pendingFrame = null;
      this.bufferFillPromise = null;

      this.gl = null;
      this.program = null;
      this.vertexBuffer = null;
      this.texture = null;
      this.aPos = -1;
      this.aTex = -1;
      this.uMatrix = null;
      this.uTexture = null;
      this.uOpacity = null;
      this.maxTextureSize = 0;
      this.textureWidth = 0;
      this.textureHeight = 0;
      this.currentBounds = null;

      this.customLayer = {
        id: this.layerId,
        type: "custom",
        renderingMode: "2d",
        onAdd: (_map, gl) => this.onAdd(gl),
        render: (gl, matrix) => this.render(gl, matrix),
        onRemove: (_map, gl) => this.onRemove(gl)
      };
    }

    frameUrl(frame) {
      return frame?.desktopImagePath || null;
    }

    buildSignature(frames = this.frames) {
      return (Array.isArray(frames) ? frames : [])
        .map((frame) => {
          const bounds = frameBounds(frame);
          return [
            this.frameUrl(frame) || "",
            frame?.validTime || "",
            bounds
              ? `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`
              : ""
          ].join("::");
        })
        .join("|");
    }

    isPrepared(signature = this.signature) {
      return (
        this.prepared &&
        !!signature &&
        signature === this.preparedSignature &&
        this.blobCache.size === this.frames.length
      );
    }

    isActive() {
      return this.active;
    }

    setOpacity(value) {
      this.opacity = clamp(Number(value), 0, 1);
      this.map?.triggerRepaint();
    }

    addToMap() {
      if (!this.map || this.map.getLayer(this.layerId)) return;

      const requestedBefore = this.beforeLayerId?.();
      const before =
        requestedBefore && this.map.getLayer(requestedBefore)
          ? requestedBefore
          : undefined;

      this.map.addLayer(this.customLayer, before);
      this.map.triggerRepaint();
    }

    deactivate() {
      this.active = false;
      this.map?.triggerRepaint();
    }

    activate() {
      this.active = true;
      this.addToMap();
      this.map?.triggerRepaint();
    }

    setFrames(frames) {
      const nextFrames = Array.isArray(frames)
        ? frames.filter(
            (frame) =>
              !!this.frameUrl(frame) &&
              !!frameBounds(frame)
          )
        : [];

      const nextSignature = this.buildSignature(nextFrames);

      if (nextSignature === this.signature) {
        this.frames = nextFrames;
        return false;
      }

      this.cancelPreparation({ clear: true, report: false });
      this.frames = nextFrames;
      this.signature = nextSignature;
      this.preparedSignature = "";
      this.prepared = false;
      this.currentFrameIndex = -1;
      this.currentBounds = null;
      return true;
    }

    async prepare(frames, startIndex = 0) {
      this.setFrames(frames);

      if (!this.frames.length) {
        throw new Error("No desktop HQ radar frames are available.");
      }

      const signature = this.signature;

      if (this.isPrepared(signature)) {
        this.progress({
          stage: "buffer",
          completed: 0,
          total: Math.min(this.bufferAhead, this.frames.length),
          label: "Refreshing HQ frame buffer"
        });

        await this.fillDecodeBuffer(startIndex, {
          awaitCompletion: true
        });

        this.progress({
          stage: "ready",
          completed: this.frames.length,
          total: this.frames.length,
          label: "HQ Loop Ready"
        });

        return true;
      }

      this.cancelPreparation({ clear: true, report: false });
      this.frames = Array.isArray(frames)
        ? frames.filter(
            (frame) =>
              !!this.frameUrl(frame) &&
              !!frameBounds(frame)
          )
        : [];
      this.signature = this.buildSignature(this.frames);

      if (!this.frames.length) {
        throw new Error("No desktop HQ radar frames are available.");
      }

      const generation = ++this.generation;
      this.abortController = new AbortController();
      this.preparing = true;
      this.prepared = false;
      this.preparedSignature = "";

      this.progress({
        stage: "download",
        completed: 0,
        total: this.frames.length,
        label: "Downloading high-resolution frames"
      });

      try {
        await this.downloadAllFrames(
          startIndex,
          generation,
          this.abortController.signal
        );

        if (generation !== this.generation) {
          return false;
        }

        const bufferTotal = Math.min(
          this.bufferAhead,
          this.frames.length
        );

        this.progress({
          stage: "buffer",
          completed: 0,
          total: bufferTotal,
          label: "Optimizing GPU frame buffer"
        });

        await this.fillDecodeBuffer(startIndex, {
          generation,
          awaitCompletion: true,
          progressStage: true
        });

        if (generation !== this.generation) {
          return false;
        }

        this.prepared = true;
        this.preparedSignature = this.signature;
        this.preparing = false;

        this.progress({
          stage: "ready",
          completed: this.frames.length,
          total: this.frames.length,
          label: "HQ Loop Ready"
        });

        return true;
      } catch (error) {
        if (generation === this.generation) {
          this.preparing = false;
          this.prepared = false;
          this.preparedSignature = "";
        }

        if (error?.name === "AbortError") {
          return false;
        }

        this.progress({
          stage: "error",
          completed: this.blobCache.size,
          total: this.frames.length,
          label: error?.message || "HQ loop preparation failed"
        });

        throw error;
      }
    }

    async downloadAllFrames(startIndex, generation, signal) {
      const length = this.frames.length;
      const start = normalizedIndex(startIndex, length);
      const order = Array.from(
        { length },
        (_, offset) => normalizedIndex(start + offset, length)
      );

      let cursor = 0;
      let completed = 0;

      const worker = async () => {
        while (cursor < order.length) {
          const orderIndex = cursor;
          cursor += 1;

          if (generation !== this.generation) return;
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");

          const frameIndex = order[orderIndex];

          if (!this.blobCache.has(frameIndex)) {
            const blob = await this.downloadFrame(
              frameIndex,
              generation,
              signal
            );

            if (generation !== this.generation) return;
            this.blobCache.set(frameIndex, blob);
          }

          completed += 1;

          this.progress({
            stage: "download",
            completed,
            total: order.length,
            frameIndex,
            label: `Downloading frame ${completed} of ${order.length}`
          });
        }
      };

      const workerCount = Math.min(
        this.downloadConcurrency,
        order.length
      );

      await Promise.all(
        Array.from({ length: workerCount }, () => worker())
      );
    }

    async downloadFrame(frameIndex, generation, signal) {
      const frame = this.frames[frameIndex];
      const url = this.frameUrl(frame);

      if (!url) {
        throw new Error(`HQ frame ${frameIndex + 1} has no desktop image.`);
      }

      const attempts = this.retryCount + 1;
      let lastError = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (generation !== this.generation) {
          throw new DOMException("Aborted", "AbortError");
        }

        try {
          const response = await fetch(url, {
            cache: "force-cache",
            signal
          });

          if (!response.ok) {
            throw new Error(
              `HQ frame ${frameIndex + 1} failed (${response.status})`
            );
          }

          const blob = await response.blob();

          if (!blob.size) {
            throw new Error(
              `HQ frame ${frameIndex + 1} returned an empty file`
            );
          }

          return blob;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          lastError = error;

          if (attempt < attempts && this.retryDelayMs > 0) {
            await sleep(this.retryDelayMs * attempt);
          }
        }
      }

      throw lastError || new Error(
        `HQ frame ${frameIndex + 1} could not be downloaded`
      );
    }

    async decodeFrame(frameIndex, generation = this.generation) {
      const index = normalizedIndex(frameIndex, this.frames.length);
      if (index < 0) return null;

      if (this.bitmapCache.has(index)) {
        return this.bitmapCache.get(index);
      }

      let promise = this.decodePromises.get(index);

      if (!promise) {
        promise = (async () => {
          const blob = this.blobCache.get(index);

          if (!blob) {
            throw new Error(
              `HQ frame ${index + 1} is not downloaded`
            );
          }

          let bitmap;

          try {
            bitmap = await createImageBitmap(blob, {
              premultiplyAlpha: "none",
              colorSpaceConversion: "none"
            });
          } catch (_error) {
            bitmap = await createImageBitmap(blob);
          }

          if (generation !== this.generation) {
            closeBitmap(bitmap);
            return null;
          }

          this.bitmapCache.set(index, bitmap);
          return bitmap;
        })().finally(() => {
          this.decodePromises.delete(index);
        });

        this.decodePromises.set(index, promise);
      }

      return promise;
    }

    bufferIndexes(startIndex) {
      const length = this.frames.length;
      const start = normalizedIndex(startIndex, length);
      const count = Math.min(this.bufferAhead, length);

      return Array.from(
        { length: count },
        (_, offset) => normalizedIndex(start + offset, length)
      );
    }

    pruneDecodedBuffer(keepIndexes) {
      const keep = new Set(keepIndexes);

      for (const [index, bitmap] of this.bitmapCache.entries()) {
        if (keep.has(index)) continue;
        closeBitmap(bitmap);
        this.bitmapCache.delete(index);
      }
    }

    async fillDecodeBuffer(startIndex, options = {}) {
      const generation = options.generation ?? this.generation;
      const indexes = this.bufferIndexes(startIndex);
      this.pruneDecodedBuffer(indexes);

      const run = async () => {
        let cursor = 0;
        let completed = indexes.filter(
          (index) => this.bitmapCache.has(index)
        ).length;

        if (options.progressStage) {
          this.progress({
            stage: "buffer",
            completed,
            total: indexes.length,
            label: `Optimizing frame ${completed} of ${indexes.length}`
          });
        }

        const worker = async () => {
          while (cursor < indexes.length) {
            const slot = cursor;
            cursor += 1;

            if (generation !== this.generation) return;

            const index = indexes[slot];

            if (this.bitmapCache.has(index)) {
              continue;
            }

            await this.decodeFrame(index, generation);

            if (generation !== this.generation) return;

            completed += 1;

            if (options.progressStage) {
              this.progress({
                stage: "buffer",
                completed: Math.min(completed, indexes.length),
                total: indexes.length,
                frameIndex: index,
                label:
                  `Optimizing frame ${Math.min(completed, indexes.length)}` +
                  ` of ${indexes.length}`
              });
            }
          }
        };

        const workerCount = Math.min(
          this.decodeConcurrency,
          indexes.length
        );

        await Promise.all(
          Array.from({ length: workerCount }, () => worker())
        );

        return true;
      };

      if (options.awaitCompletion) {
        return run();
      }

      if (!this.bufferFillPromise) {
        this.bufferFillPromise = run()
          .catch((error) => {
            if (error?.name !== "AbortError") {
              console.warn("HQ radar buffer fill failed", error);
            }
            return false;
          })
          .finally(() => {
            this.bufferFillPromise = null;
          });
      }

      return this.bufferFillPromise;
    }

    async displayFrame(frameIndex) {
      if (!this.isPrepared()) {
        throw new Error("The HQ radar loop is not prepared.");
      }

      const index = normalizedIndex(frameIndex, this.frames.length);
      const generation = this.generation;
      const bitmap = await this.decodeFrame(index, generation);

      if (!bitmap || generation !== this.generation) {
        return false;
      }

      const bounds = frameBounds(this.frames[index]);

      if (!bounds) {
        throw new Error(`HQ frame ${index + 1} has invalid bounds.`);
      }

      if (this.pendingFrame?.bitmap) {
        closeBitmap(this.pendingFrame.bitmap);
      }

      this.bitmapCache.delete(index);
      this.pendingFrame = {
        index,
        bounds,
        bitmap
      };

      this.currentFrameIndex = index;
      this.currentBounds = bounds;
      this.activate();
      this.map?.triggerRepaint();

      const nextIndex = normalizedIndex(index + 1, this.frames.length);
      void this.fillDecodeBuffer(nextIndex);

      return true;
    }

    cancelPreparation(options = {}) {
      const clear = options.clear !== false;
      const report = options.report !== false;

      this.generation += 1;

      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }

      this.preparing = false;
      this.bufferFillPromise = null;
      this.decodePromises.clear();

      if (clear) {
        this.clearPreparedData();
      }

      if (report) {
        this.progress({
          stage: "canceled",
          completed: 0,
          total: this.frames.length,
          label: "HQ loop preparation canceled"
        });
      }
    }

    clearPreparedData() {
      for (const bitmap of this.bitmapCache.values()) {
        closeBitmap(bitmap);
      }

      this.bitmapCache.clear();
      this.blobCache.clear();

      if (this.pendingFrame?.bitmap) {
        closeBitmap(this.pendingFrame.bitmap);
      }

      this.pendingFrame = null;
      this.prepared = false;
      this.preparedSignature = "";
      this.textureWidth = 0;
      this.textureHeight = 0;
    }

    dispose() {
      this.cancelPreparation({ clear: true, report: false });
      this.active = false;

      if (this.map?.getLayer(this.layerId)) {
        this.map.removeLayer(this.layerId);
      }

      this.frames = [];
      this.signature = "";
      this.currentFrameIndex = -1;
      this.currentBounds = null;
    }

    compileShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);

      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`HQ radar shader compile failed: ${message}`);
      }

      return shader;
    }

    onAdd(gl) {
      this.gl = gl;
      this.maxTextureSize = Number(
        gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0
      );

      const vertexShader = this.compileShader(
        gl,
        gl.VERTEX_SHADER,
        `
          attribute vec2 a_pos;
          attribute vec2 a_tex;
          uniform mat4 u_matrix;
          varying vec2 v_tex;

          void main() {
            gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
            v_tex = a_tex;
          }
        `
      );

      const fragmentShader = this.compileShader(
        gl,
        gl.FRAGMENT_SHADER,
        `
          precision mediump float;
          uniform sampler2D u_texture;
          uniform float u_opacity;
          varying vec2 v_tex;

          void main() {
            vec4 color = texture2D(u_texture, v_tex);
            gl_FragColor = vec4(color.rgb, color.a * u_opacity);
          }
        `
      );

      this.program = gl.createProgram();
      gl.attachShader(this.program, vertexShader);
      gl.attachShader(this.program, fragmentShader);
      gl.linkProgram(this.program);

      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        throw new Error(
          `HQ radar shader link failed: ${gl.getProgramInfoLog(this.program)}`
        );
      }

      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      this.aPos = gl.getAttribLocation(this.program, "a_pos");
      this.aTex = gl.getAttribLocation(this.program, "a_tex");
      this.uMatrix = gl.getUniformLocation(this.program, "u_matrix");
      this.uTexture = gl.getUniformLocation(this.program, "u_texture");
      this.uOpacity = gl.getUniformLocation(this.program, "u_opacity");

      this.vertexBuffer = gl.createBuffer();
      this.texture = gl.createTexture();

      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.NEAREST
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.NEAREST
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    onRemove(gl) {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
      if (this.program) gl.deleteProgram(this.program);

      this.texture = null;
      this.vertexBuffer = null;
      this.program = null;
      this.gl = null;
      this.textureWidth = 0;
      this.textureHeight = 0;
    }

    uploadPendingFrame(gl) {
      const pending = this.pendingFrame;
      if (!pending?.bitmap || !this.texture) return;

      const width = Number(pending.bitmap.width || 0);
      const height = Number(pending.bitmap.height || 0);

      if (
        !width ||
        !height ||
        width > this.maxTextureSize ||
        height > this.maxTextureSize
      ) {
        closeBitmap(pending.bitmap);
        this.pendingFrame = null;

        throw new Error(
          `HQ radar frame ${width}x${height} exceeds GPU limit ` +
          `${this.maxTextureSize}x${this.maxTextureSize}`
        );
      }

      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      // Keep upload behavior neutral and handle north/south orientation
      // explicitly in vertexData().
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pending.bitmap
      );

      this.textureWidth = width;
      this.textureHeight = height;
      this.currentFrameIndex = pending.index;
      this.currentBounds = pending.bounds;

      closeBitmap(pending.bitmap);
      this.pendingFrame = null;
    }

    vertexData(bounds) {
      const nw = mapboxgl.MercatorCoordinate.fromLngLat({
        lng: bounds.west,
        lat: bounds.north
      });
      const ne = mapboxgl.MercatorCoordinate.fromLngLat({
        lng: bounds.east,
        lat: bounds.north
      });
      const se = mapboxgl.MercatorCoordinate.fromLngLat({
        lng: bounds.east,
        lat: bounds.south
      });
      const sw = mapboxgl.MercatorCoordinate.fromLngLat({
        lng: bounds.west,
        lat: bounds.south
      });

      // Empirically verified in Chrome: the rendered WebP north edge is
      // sampled at texture v=1 for the ImageBitmap upload path.
      return new Float32Array([
        nw.x, nw.y, 0, 1,
        ne.x, ne.y, 1, 1,
        se.x, se.y, 1, 0,
        nw.x, nw.y, 0, 1,
        se.x, se.y, 1, 0,
        sw.x, sw.y, 0, 0
      ]);
    }

    render(gl, matrix) {
      if (this.pendingFrame?.bitmap) {
        try {
          this.uploadPendingFrame(gl);
        } catch (error) {
          console.error("HQ radar texture upload failed", error);
          this.status(error?.message || "HQ radar texture upload failed");
          this.active = false;
        }
      }

      if (
        !this.active ||
        !this.program ||
        !this.texture ||
        !this.currentBounds ||
        !this.textureWidth ||
        !this.textureHeight
      ) {
        return;
      }

      const vertices = this.vertexData(this.currentBounds);

      gl.useProgram(this.program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);

      const stride = 4 * Float32Array.BYTES_PER_ELEMENT;

      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(
        this.aPos,
        2,
        gl.FLOAT,
        false,
        stride,
        0
      );

      gl.enableVertexAttribArray(this.aTex);
      gl.vertexAttribPointer(
        this.aTex,
        2,
        gl.FLOAT,
        false,
        stride,
        2 * Float32Array.BYTES_PER_ELEMENT
      );

      gl.uniformMatrix4fv(this.uMatrix, false, matrix);
      gl.uniform1i(this.uTexture, 0);
      gl.uniform1f(this.uOpacity, this.opacity);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    debugState() {
      return {
        preparing: this.preparing,
        prepared: this.prepared,
        active: this.active,
        frameCount: this.frames.length,
        downloadedFrames: this.blobCache.size,
        decodedFrames: this.bitmapCache.size,
        pendingDecodes: this.decodePromises.size,
        currentFrameIndex: this.currentFrameIndex,
        pendingFrameIndex: this.pendingFrame?.index ?? null,
        textureSize:
          this.textureWidth && this.textureHeight
            ? `${this.textureWidth}x${this.textureHeight}`
            : "",
        maxTextureSize: this.maxTextureSize,
        textureOrientation: "north-up-v2",
        textureNorthV: 1,
        bufferAhead: this.bufferAhead,
        downloadConcurrency: this.downloadConcurrency,
        decodeConcurrency: this.decodeConcurrency,
        signature: this.signature,
        preparedSignature: this.preparedSignature
      };
    }
  }

  window.Level2HqPlaybackEngine = Level2HqPlaybackEngine;
})();
