(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const HOME_MODE = params.get("home") === "1";
  const DETAIL_MANIFEST_URL =
    "https://dt0cd6bl1yqh2.cloudfront.net/mrms-detail/manifest.json";
  const LAYER_ID = "mrms-native-detail-overlay";
  const MIN_DETAIL_MAP_ZOOM = 4.6;
  const MOBILE_DEVICE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const MAX_GPU_CHUNKS = MOBILE_DEVICE ? 10 : 24;
  const MAX_FETCHES = MOBILE_DEVICE ? 2 : 4;
  const PREFETCH_FRAMES = MOBILE_DEVICE ? 2 : 4;
  const VIEWPORT_SYNC_MS = MOBILE_DEVICE ? 140 : 90;
  const POLL_MS = 30000;
  const STARTED_AT = Date.now();
  const INSTALL_TIMEOUT_MS = 20000;
  const LATITUDE_SEGMENTS = 64;

  let installed = false;
  let overlay = null;
  let detailArchive = null;
  let pollTimer = null;
  let syncTimer = null;
  let retryTimer = null;

  function ready() {
    try {
      return (
        typeof map !== "undefined" &&
        typeof radarLayer !== "undefined" &&
        typeof radarVisible !== "undefined" &&
        typeof frames !== "undefined" &&
        typeof currentFrameIndex !== "undefined" &&
        typeof isPlaying !== "undefined" &&
        typeof showFrame === "function" &&
        typeof startPlayback === "function" &&
        typeof stopPlayback === "function" &&
        typeof opacityInput !== "undefined" &&
        map &&
        typeof map.addLayer === "function" &&
        typeof map.isStyleLoaded === "function" &&
        map.isStyleLoaded() &&
        radarLayer &&
        Array.isArray(frames) &&
        frames.length > 0
      );
    } catch (_) {
      return false;
    }
  }

  async function fetchManifest() {
    const separator = DETAIL_MANIFEST_URL.includes("?") ? "&" : "?";
    const response = await fetch(
      DETAIL_MANIFEST_URL + separator + "t=" + Date.now(),
      { cache: "no-store" }
    );
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) {
      throw new Error("Native MRMS detail manifest HTTP " + response.status);
    }
    const manifest = await response.json();
    const singleFrame =
      manifest.mode === "native-grid-chunks" &&
      Array.isArray(manifest.chunks) &&
      manifest.chunks.length > 0;
    const archive =
      manifest.mode === "native-grid-chunk-archive" &&
      Array.isArray(manifest.frames) &&
      Array.isArray(manifest.chunkLayout) &&
      typeof manifest.imageTemplate === "string";
    if (!singleFrame && !archive) {
      throw new Error("Native MRMS detail manifest is incomplete");
    }
    manifest._url = DETAIL_MANIFEST_URL;
    return manifest;
  }

  function currentBaseFrameId() {
    return String(frames?.[currentFrameIndex]?.id || "");
  }

  function frameManifestFromArchive(archive, frameId) {
    if (!archive || !frameId) return null;
    if (archive.mode === "native-grid-chunks") {
      return String(archive.revision) === String(frameId)
        ? archive
        : null;
    }

    const frame = (archive.frames || []).find(
      item => String(item.revision) === String(frameId)
    );
    if (!frame) return null;

    // Newer archive manifests can retain multiple chunk layouts at once.
    // That lets us migrate from large 2048px textures to smaller 1024px
    // textures without invalidating historical native-detail revisions.
    const layoutId = String(frame.layoutId || "");
    const frameLayout =
      layoutId &&
      archive.layouts &&
      typeof archive.layouts === "object"
        ? archive.layouts[layoutId]
        : null;

    const chunkLayout =
      frameLayout?.chunkLayout ||
      archive.chunkLayout ||
      [];

    const chunks = chunkLayout.map(layout => {
      const image = archive.imageTemplate
        .replace("{revision}", String(frame.revision))
        .replace("{chunkId}", String(layout.id));
      return { ...layout, image };
    });

    return {
      revision: String(frame.revision),
      validTime: frame.validTime,
      sourceName: frame.sourceName,
      mode: "native-grid-chunks",
      bounds: archive.bounds,
      nativeWidth: archive.nativeWidth,
      nativeHeight: archive.nativeHeight,
      chunkPixels:
        frameLayout?.chunkPixels ??
        archive.chunkPixels,
      rows:
        frameLayout?.rows ??
        archive.rows,
      columns:
        frameLayout?.columns ??
        archive.columns,
      chunks,
      _url: archive._url
    };
  }

  function syncFrameManifest() {
    if (!overlay) return;
    overlay.setManifest(
      frameManifestFromArchive(
        detailArchive,
        currentBaseFrameId()
      )
    );
  }

  function currentPlaybackSpeed() {
    try {
      if (typeof speedSelect !== "undefined") {
        return Math.max(0.25, Number(speedSelect.value) || 1);
      }
    } catch (_) {}
    return 1;
  }

  function prefetchUpcomingDetail() {
    if (
      !overlay?.enabled ||
      !isPlaying ||
      frames.length < 2 ||
      map?.isMoving?.()
    ) {
      return;
    }

    const speed = currentPlaybackSpeed();

    // Mobile 2x playback has very little decode/GPU headroom. Prioritize the
    // exact next observation instead of spending bandwidth several frames out.
    const lookahead =
      speed >= 2
        ? Math.min(
            MOBILE_DEVICE ? 1 : 2,
            frames.length - 1
          )
        : Math.min(PREFETCH_FRAMES, frames.length - 1);

    const frameIds = [];

    for (let offset = 1; offset <= lookahead; offset += 1) {
      const index = (currentFrameIndex + offset) % frames.length;
      const frameId = String(frames[index]?.id || "");

      if (frameId && !frameIds.includes(frameId)) {
        frameIds.push(frameId);
      }
    }

    overlay.prefetchFrames(frameIds);
  }

  async function bitmapFromUrl(url, signal = undefined) {
    const response = await fetch(url, {
      cache: "force-cache",
      signal
    });
    if (!response.ok) {
      throw new Error(
        "Native MRMS detail chunk HTTP " + response.status + ": " + url
      );
    }
    const blob = await response.blob();
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob, {
          premultiplyAlpha: "none",
          colorSpaceConversion: "none"
        });
      } catch (_) {
        return await createImageBitmap(blob);
      }
    }
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(blob);
      image.decoding = "async";
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Native MRMS detail chunk decode failed"));
      };
      image.src = objectUrl;
    });
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "shader compile failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createTexture(gl, image) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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
    return texture;
  }

  function chunkIntersects(chunk, bounds) {
    const values = chunk.bounds.map(Number);
    const west = values[0];
    const south = values[1];
    const east = values[2];
    const north = values[3];
    return !(
      east <= bounds.getWest() ||
      west >= bounds.getEast() ||
      north <= bounds.getSouth() ||
      south >= bounds.getNorth()
    );
  }

  function meshForChunk(chunk) {
    const values = chunk.bounds.map(Number);
    const west = values[0];
    const south = values[1];
    const east = values[2];
    const north = values[3];
    const x0 = mapboxgl.MercatorCoordinate.fromLngLat([west, 0]).x;
    const x1 = mapboxgl.MercatorCoordinate.fromLngLat([east, 0]).x;
    const positions = [];
    const uvs = [];

    function append(x, y, u, v) {
      positions.push(x, y);
      uvs.push(u, v);
    }

    for (let band = 0; band < LATITUDE_SEGMENTS; band += 1) {
      const v0 = band / LATITUDE_SEGMENTS;
      const v1 = (band + 1) / LATITUDE_SEGMENTS;
      const lat0 = north - (north - south) * v0;
      const lat1 = north - (north - south) * v1;
      const y0 = mapboxgl.MercatorCoordinate.fromLngLat([0, lat0]).y;
      const y1 = mapboxgl.MercatorCoordinate.fromLngLat([0, lat1]).y;

      append(x0, y0, 0, v0);
      append(x0, y1, 0, v1);
      append(x1, y0, 1, v0);
      append(x1, y0, 1, v0);
      append(x0, y1, 0, v1);
      append(x1, y1, 1, v1);
    }

    return {
      positions: new Float32Array(positions),
      uvs: new Float32Array(uvs),
      vertexCount: LATITUDE_SEGMENTS * 6
    };
  }

  function firstSymbolLayerId() {
    return (map.getStyle()?.layers || []).find(
      layer => layer.type === "symbol"
    )?.id;
  }

  function createOverlay(initialManifest) {
    return {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "2d",
      manifest: initialManifest,
      frameAvailable: Boolean(initialManifest),
      enabled: false,
      cache: new Map(),
      geometryCache: new Map(),
      pending: new Set(),
      controllers: new Map(),
      activeKeys: new Set(),
      queue: [],
      activeFetches: 0,
      wanted: new Map(),
      drawSet: [],

      onAdd(mapRef, gl) {
        this.map = mapRef;
        this.gl = gl;
        const vertexSource = [
          "precision highp float;",
          "uniform mat4 u_matrix;",
          "attribute vec2 a_pos;",
          "attribute vec2 a_uv;",
          "varying vec2 v_uv;",
          "void main() {",
          "  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);",
          "  v_uv = a_uv;",
          "}"
        ].join("\n");
        const fragmentSource = [
          "precision mediump float;",
          "uniform sampler2D u_texture;",
          "uniform float u_opacity;",
          "varying vec2 v_uv;",
          "void main() {",
          "  vec4 radar = texture2D(u_texture, v_uv);",
          "  gl_FragColor = vec4(radar.rgb, radar.a * u_opacity);",
          "}"
        ].join("\n");
        const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
          throw new Error(
            gl.getProgramInfoLog(this.program) ||
              "Native MRMS detail shader link failed"
          );
        }
        this.aPos = gl.getAttribLocation(this.program, "a_pos");
        this.aUv = gl.getAttribLocation(this.program, "a_uv");
        this.uMatrix = gl.getUniformLocation(this.program, "u_matrix");
        this.uTexture = gl.getUniformLocation(this.program, "u_texture");
        this.uOpacity = gl.getUniformLocation(this.program, "u_opacity");
        this.updateWanted();
      },

      geometryKey(chunk) {
        return (
          String(chunk.id) +
          ":" +
          (chunk.bounds || []).map(Number).join(",")
        );
      },

      geometryForChunk(chunk) {
        const key = this.geometryKey(chunk);
        const existing = this.geometryCache.get(key);
        if (existing) return existing;
        if (!this.gl) return null;

        const gl = this.gl;
        const mesh = meshForChunk(chunk);

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          mesh.positions,
          gl.STATIC_DRAW
        );

        const uvBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          mesh.uvs,
          gl.STATIC_DRAW
        );

        const geometry = {
          posBuffer,
          uvBuffer,
          vertexCount: mesh.vertexCount
        };

        this.geometryCache.set(key, geometry);
        return geometry;
      },

      key(chunk, manifest = this.manifest) {
        return String(manifest.revision) + ":" + String(chunk.id);
      },

      chunkUrl(chunk, manifestUrl = this.manifest._url) {
        return new URL(
          String(chunk.image),
          new URL(".", manifestUrl)
        ).href;
      },

      visibleChunks(manifest = this.manifest) {
        const bounds = this.map.getBounds();
        return manifest.chunks.filter(
          chunk => chunkIntersects(chunk, bounds)
        );
      },

      prioritizeCurrentViewport(
        chunks,
        manifest = this.manifest
      ) {
        const allowedKeys = new Set(
          chunks.map(chunk =>
            this.key(chunk, manifest)
          )
        );

        const keepQueue = [];

        for (const item of this.queue) {
          if (allowedKeys.has(item.key)) {
            keepQueue.push(item);
            continue;
          }

          const controller =
            this.controllers.get(item.key);

          if (
            controller &&
            !this.activeKeys.has(item.key)
          ) {
            controller.abort();
          }

          if (!this.activeKeys.has(item.key)) {
            this.pending.delete(item.key);
            this.controllers.delete(item.key);
          }
        }

        this.queue = keepQueue;

        // Abort stale requests already consuming one of the limited fetch
        // slots. The CURRENT observation and CURRENT viewport always win.
        for (const key of this.activeKeys) {
          if (allowedKeys.has(key)) continue;
          this.controllers.get(key)?.abort();
        }
      },

      updateWanted() {
        if (!this.enabled) return;

        const visible = this.visibleChunks();

        this.prioritizeCurrentViewport(
          visible,
          this.manifest
        );

        this.wanted = new Map(
          visible.map(chunk => [this.key(chunk), chunk])
        );

        this.queueChunks(
          visible,
          this.manifest,
          true
        );

        this.evict();
        this.syncVisibility();
      },

      queueChunks(
        chunks,
        manifest = this.manifest,
        priority = false
      ) {
        const additions = [];
        const requestedKeys = new Set();

        for (const chunk of chunks) {
          const key = this.key(chunk, manifest);
          requestedKeys.add(key);

          if (
            this.cache.has(key) ||
            this.pending.has(key)
          ) {
            continue;
          }

          const controller =
            new AbortController();

          this.pending.add(key);
          this.controllers.set(key, controller);

          additions.push({
            chunk,
            key,
            manifestUrl: manifest._url,
            controller
          });
        }

        if (priority) {
          const promoted =
            this.queue.filter(item =>
              requestedKeys.has(item.key)
            );

          this.queue =
            this.queue.filter(item =>
              !requestedKeys.has(item.key)
            );

          this.queue.unshift(
            ...promoted,
            ...additions
          );
        } else {
          this.queue.push(...additions);
        }

        this.pump();
      },

      prefetchFrames(frameIds) {
        if (!this.enabled || !detailArchive || !Array.isArray(frameIds)) return;

        frameIds.forEach((frameId, index) => {
          const manifest = frameManifestFromArchive(detailArchive, frameId);
          if (!manifest) return;

          // The immediate next frame gets promoted ahead of older speculative
          // work. Additional lookahead remains lower-priority background work.
          this.queueChunks(
            this.visibleChunks(manifest),
            manifest,
            index === 0
          );
        });
      },

      async pump() {
        while (
          this.activeFetches < MAX_FETCHES &&
          this.queue.length
        ) {
          const item = this.queue.shift();

          if (this.cache.has(item.key)) {
            this.pending.delete(item.key);
            this.controllers.delete(item.key);
            continue;
          }

          if (item.controller?.signal?.aborted) {
            this.pending.delete(item.key);
            this.controllers.delete(item.key);
            continue;
          }

          this.activeFetches += 1;
          this.activeKeys.add(item.key);

          this.fetchChunk(item).finally(() => {
            this.activeKeys.delete(item.key);
            this.activeFetches -= 1;
            this.pump();
          });
        }
      },

      async fetchChunk(item) {
        try {
          const bitmap = await bitmapFromUrl(
            this.chunkUrl(
              item.chunk,
              item.manifestUrl
            ),
            item.controller?.signal
          );
          if (!this.gl) return;
          const texture = createTexture(this.gl, bitmap);
          if (bitmap.close) bitmap.close();

          const geometry = this.geometryForChunk(item.chunk);
          if (!geometry) {
            this.gl.deleteTexture(texture);
            return;
          }

          this.cache.set(item.key, {
            texture,
            chunk: item.chunk,
            geometry,
            lastUsed: performance.now()
          });
        } catch (error) {
          if (error?.name !== "AbortError") {
            console.warn(
              "Native MRMS detail chunk " +
                item.key +
                " failed",
              error
            );
          }
        } finally {
          this.pending.delete(item.key);
          this.controllers.delete(item.key);
          this.evict();
          this.syncVisibility();
          this.map?.triggerRepaint();
        }
      },

      clearTextures() {
        if (this.gl) {
          for (const value of this.cache.values()) {
            if (value.texture) this.gl.deleteTexture(value.texture);
          }
        }
        this.cache.clear();
      },

      clearGeometry() {
        if (this.gl) {
          for (const geometry of this.geometryCache.values()) {
            if (geometry.posBuffer) {
              this.gl.deleteBuffer(geometry.posBuffer);
            }
            if (geometry.uvBuffer) {
              this.gl.deleteBuffer(geometry.uvBuffer);
            }
          }
        }
        this.geometryCache.clear();
      },

      setManifest(next) {
        if (!next) {
          this.frameAvailable = false;
          this.enabled = false;
          this.wanted = new Map();
          this.drawSet = [];

          for (const controller of this.controllers.values()) {
            controller.abort();
          }

          this.queue = [];
          radarLayer?.setVisible(radarVisible);
          this.syncVisibility();
          this.map?.triggerRepaint();
          return;
        }

        if (
          this.frameAvailable &&
          this.manifest &&
          next.revision === this.manifest.revision
        ) {
          return;
        }

        // The lower-resolution 4096px observation is authoritative for
        // animation. Never let an old native frame remain visually dominant
        // after the timeline advances.
        radarLayer?.setVisible(radarVisible);

        this.frameAvailable = true;
        this.manifest = next;
        this.wanted = new Map();
        this.drawSet = [];

        this.map?.triggerRepaint();

        if (this.enabled) {
          this.updateWanted();
        }
      },

      setEnabled(value) {
        const next = Boolean(value);
        if (next === this.enabled) return;

        this.enabled = next;

        if (this.enabled) {
          this.updateWanted();
        } else {
          this.wanted = new Map();
          this.syncVisibility();
        }

        this.map?.triggerRepaint();
      },

      readyForViewport() {
        return (
          this.wanted.size > 0 &&
          [...this.wanted.keys()].every(key => this.cache.has(key))
        );
      },

      syncVisibility() {
        const revisionMatches =
          String(this.manifest?.revision || "") ===
          currentBaseFrameId();

        const detailReady =
          this.enabled &&
          radarVisible &&
          revisionMatches &&
          this.readyForViewport();

        radarLayer?.setVisible(
          radarVisible && !detailReady
        );
      },

      evict() {
        if (!this.gl || this.cache.size <= MAX_GPU_CHUNKS) return;
        const protectedKeys = new Set([
          ...this.wanted.keys(),
          ...this.drawSet.map(item => item.key)
        ]);
        const removable = [...this.cache.entries()]
          .filter(([key]) => !protectedKeys.has(key))
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        while (
          this.cache.size > MAX_GPU_CHUNKS &&
          removable.length
        ) {
          const entry = removable.shift();
          const key = entry[0];
          const value = entry[1];
          this.gl.deleteTexture(value.texture);
          this.cache.delete(key);
        }
      },

      drawChunk(gl, matrix, item) {
        const cached = this.cache.get(item.key);
        if (!cached?.texture || !cached?.geometry) return;

        cached.lastUsed = performance.now();

        const geometry = cached.geometry;

        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uMatrix, false, matrix);
        gl.uniform1i(this.uTexture, 0);
        gl.uniform1f(
          this.uOpacity,
          Number(opacityInput?.value ?? 1)
        );

        gl.bindBuffer(
          gl.ARRAY_BUFFER,
          geometry.posBuffer
        );
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(
          this.aPos,
          2,
          gl.FLOAT,
          false,
          0,
          0
        );

        gl.bindBuffer(
          gl.ARRAY_BUFFER,
          geometry.uvBuffer
        );
        gl.enableVertexAttribArray(this.aUv);
        gl.vertexAttribPointer(
          this.aUv,
          2,
          gl.FLOAT,
          false,
          0,
          0
        );

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cached.texture);

        gl.drawArrays(
          gl.TRIANGLES,
          0,
          geometry.vertexCount
        );
      },

      render(gl, matrix) {
        const revisionMatches =
          String(this.manifest?.revision || "") ===
          currentBaseFrameId();

        if (
          !this.enabled ||
          !radarVisible ||
          !revisionMatches
        ) {
          this.drawSet = [];
          this.syncVisibility();
          return;
        }

        // Progressive refinement: render every native chunk that is already
        // available instead of waiting for the slowest chunk in the viewport.
        // The lightweight national layer remains underneath until all wanted
        // chunks for this frame are ready.
        this.drawSet = [...this.wanted.entries()]
          .filter(([key]) => this.cache.has(key))
          .map(([key, chunk]) => ({ key, chunk }));

        if (!this.drawSet.length) {
          this.syncVisibility();
          return;
        }

        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA
        );

        for (const item of this.drawSet) {
          this.drawChunk(gl, matrix, item);
        }

        this.syncVisibility();
      },

      onRemove(mapRef, gl) {
        this.clearTextures();
        this.clearGeometry();
        if (this.program) gl.deleteProgram(this.program);
        this.gl = null;
      }
    };
  }

  function shouldShowDetail() {
    try {
      return (
        frames.length > 0 &&
        overlay?.frameAvailable &&
        radarVisible &&
        map.getZoom() >= MIN_DETAIL_MAP_ZOOM
      );
    } catch (_) {
      return false;
    }
  }

  function syncMode() {
    if (!overlay) return;
    overlay.setEnabled(shouldShowDetail());
    if (!overlay.enabled) {
      radarLayer?.setVisible(radarVisible);
    }
  }

  async function install(manifest) {
    if (installed || !manifest || !ready()) return false;
    installed = true;
    overlay = createOverlay(manifest);
    const beforeId = firstSymbolLayerId();
    if (beforeId) map.addLayer(overlay, beforeId);
    else map.addLayer(overlay);

    const originalShowFrame = showFrame;
    showFrame = async function (...args) {
      // Camera interaction gets first priority. Playback holds the current
      // observation only while Mapbox is actively moving.
      if (isPlaying && map?.isMoving?.()) {
        return false;
      }

      // Base animation is authoritative. Native detail must never delay the
      // observation clock or leave an older sharp frame over a newer base
      // observation.
      radarLayer?.setVisible(radarVisible);

      const result =
        await originalShowFrame(...args);

      syncFrameManifest();
      syncMode();
      prefetchUpcomingDetail();

      return result;
    };

    const originalStartPlayback = startPlayback;
    startPlayback = async function (...args) {
      radarLayer?.setVisible(radarVisible);
      const result = await originalStartPlayback(...args);
      prefetchUpcomingDetail();
      return result;
    };

    const originalStopPlayback = stopPlayback;
    stopPlayback = function (...args) {
      const result = originalStopPlayback(...args);
      window.setTimeout(syncMode, 0);
      return result;
    };

    let viewportSyncTimer = null;
    let lastViewportSyncAt = 0;

    const refreshViewportDetail = (includePrefetch = false) => {
      syncMode();

      if (overlay?.enabled) {
        overlay.updateWanted();

        if (includePrefetch) {
          prefetchUpcomingDetail();
        }
      }
    };

    const scheduleViewportDetail = () => {
      if (viewportSyncTimer) return;

      const elapsed =
        performance.now() - lastViewportSyncAt;

      const delay = Math.max(
        0,
        VIEWPORT_SYNC_MS - elapsed
      );

      viewportSyncTimer = window.setTimeout(() => {
        viewportSyncTimer = null;
        lastViewportSyncAt = performance.now();

        // Load only the current observation while the user is manipulating
        // the map. This keeps bandwidth/GPU work focused on responsiveness.
        refreshViewportDetail(false);
      }, delay);
    };

    map.on("move", scheduleViewportDetail);

    map.on("moveend", () => {
      if (viewportSyncTimer) {
        window.clearTimeout(viewportSyncTimer);
        viewportSyncTimer = null;
      }

      lastViewportSyncAt = performance.now();

      // Camera is settled; resume normal playback lookahead.
      refreshViewportDetail(true);
    });

    opacityInput?.addEventListener(
      "input",
      () => overlay?.map?.triggerRepaint()
    );

    syncTimer = window.setInterval(syncMode, 500);
    pollTimer = window.setInterval(async () => {
      try {
        const next = await fetchManifest();
        if (next) {
          detailArchive = next;
          syncFrameManifest();
          syncMode();
        }
      } catch (error) {
        console.warn(
          "Native MRMS detail manifest refresh failed",
          error
        );
      }
    }, POLL_MS);

    window.addEventListener(
      "beforeunload",
      () => {
        if (syncTimer) window.clearInterval(syncTimer);
        if (pollTimer) window.clearInterval(pollTimer);
        if (retryTimer) window.clearTimeout(retryTimer);
        if (viewportSyncTimer) {
          window.clearTimeout(viewportSyncTimer);
        }
      },
      { once: true }
    );

    syncMode();
    console.info(
      "Main radar native-detail archive: " +
        String(detailArchive?.frames?.length || 1) +
        " frame(s), " +
        manifest.nativeWidth +
        "x" +
        manifest.nativeHeight
    );
    return true;
  }

  async function tryInstall() {
    if (installed) return;
    const elapsed = Date.now() - STARTED_AT;
    if (!ready()) {
      if (elapsed < INSTALL_TIMEOUT_MS) {
        retryTimer = window.setTimeout(tryInstall, 100);
      } else {
        radarLayer?.setVisible(radarVisible);
        retryTimer = window.setTimeout(tryInstall, POLL_MS);
      }
      return;
    }

    try {
      const manifest = await fetchManifest();
      if (manifest) {
        detailArchive = manifest;
        const frameManifest = frameManifestFromArchive(
          detailArchive,
          currentBaseFrameId()
        );
        if (frameManifest) {
          await install(frameManifest);
          return;
        }
      }
      radarLayer?.setVisible(radarVisible);
      console.info(
        "Native MRMS detail is not published yet; using rolling-frame fallback"
      );
    } catch (error) {
      radarLayer?.setVisible(radarVisible);
      console.warn("Native MRMS detail unavailable", error);
    }
    retryTimer = window.setTimeout(tryInstall, POLL_MS);
  }

  tryInstall();
})();
