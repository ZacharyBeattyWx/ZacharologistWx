(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const HOME_MODE = params.get("home") === "1";
  const DETAIL_MANIFEST_URL =
    "https://dt0cd6bl1yqh2.cloudfront.net/mrms-detail/manifest.json";
  const LAYER_ID = "mrms-native-detail-overlay";
  const MIN_DETAIL_MAP_ZOOM = 4.6;
  const MAX_GPU_CHUNKS = 16;
  const MAX_FETCHES = 4;
  const POLL_MS = 30000;
  const STARTED_AT = Date.now();
  const INSTALL_TIMEOUT_MS = 20000;
  const LATITUDE_SEGMENTS = 64;

  let installed = false;
  let overlay = null;
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
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error("Native MRMS detail manifest HTTP " + response.status);
    }
    const manifest = await response.json();
    if (
      manifest.mode !== "native-grid-chunks" ||
      !Array.isArray(manifest.chunks) ||
      !manifest.chunks.length
    ) {
      throw new Error("Native MRMS detail manifest is incomplete");
    }
    manifest._url = DETAIL_MANIFEST_URL;
    return manifest;
  }

  async function bitmapFromUrl(url) {
    const response = await fetch(url, { cache: "force-cache" });
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
      enabled: false,
      cache: new Map(),
      pending: new Set(),
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
        this.posBuffer = gl.createBuffer();
        this.uvBuffer = gl.createBuffer();
        this.updateWanted();
      },

      key(chunk) {
        return String(this.manifest.revision) + ":" + String(chunk.id);
      },

      chunkUrl(chunk) {
        return new URL(
          String(chunk.image),
          new URL(".", this.manifest._url)
        ).href;
      },

      visibleChunks() {
        const bounds = this.map.getBounds();
        return this.manifest.chunks.filter(
          chunk => chunkIntersects(chunk, bounds)
        );
      },

      updateWanted() {
        if (!this.enabled) return;
        const visible = this.visibleChunks();
        this.wanted = new Map(
          visible.map(chunk => [this.key(chunk), chunk])
        );
        this.queueChunks(visible);
        this.evict();
        this.syncVisibility();
      },

      queueChunks(chunks) {
        for (const chunk of chunks) {
          const key = this.key(chunk);
          if (this.cache.has(key) || this.pending.has(key)) continue;
          this.pending.add(key);
          this.queue.push({ chunk, key });
        }
        this.pump();
      },

      async pump() {
        while (
          this.activeFetches < MAX_FETCHES &&
          this.queue.length
        ) {
          const item = this.queue.shift();
          if (this.cache.has(item.key)) {
            this.pending.delete(item.key);
            continue;
          }
          this.activeFetches += 1;
          this.fetchChunk(item).finally(() => {
            this.activeFetches -= 1;
            this.pump();
          });
        }
      },

      async fetchChunk(item) {
        try {
          const bitmap = await bitmapFromUrl(
            this.chunkUrl(item.chunk)
          );
          if (!this.gl) return;
          const texture = createTexture(this.gl, bitmap);
          if (bitmap.close) bitmap.close();
          this.cache.set(item.key, {
            texture,
            chunk: item.chunk,
            mesh: meshForChunk(item.chunk),
            lastUsed: performance.now()
          });
        } catch (error) {
          console.warn(
            "Native MRMS detail chunk " + item.key + " failed",
            error
          );
        } finally {
          this.pending.delete(item.key);
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

      setManifest(next) {
        if (!next || next.revision === this.manifest.revision) return;
        this.clearTextures();
        this.manifest = next;
        this.queue = [];
        this.pending.clear();
        this.wanted = new Map();
        this.drawSet = [];
        if (this.enabled) this.updateWanted();
      },

      setEnabled(value) {
        this.enabled = Boolean(value);
        if (this.enabled) this.updateWanted();
        else {
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
        const detailReady =
          this.enabled &&
          radarVisible &&
          this.readyForViewport();
        radarLayer?.setVisible(radarVisible && !detailReady);
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
        if (!cached?.texture) return;
        cached.lastUsed = performance.now();

        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uMatrix, false, matrix);
        gl.uniform1i(this.uTexture, 0);
        gl.uniform1f(
          this.uOpacity,
          Number(opacityInput?.value ?? 1)
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          cached.mesh.positions,
          gl.DYNAMIC_DRAW
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
        gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          cached.mesh.uvs,
          gl.DYNAMIC_DRAW
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
          cached.mesh.vertexCount
        );
      },

      render(gl, matrix) {
        if (
          !this.enabled ||
          !radarVisible ||
          !this.readyForViewport()
        ) {
          this.syncVisibility();
          return;
        }

        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.drawSet = [...this.wanted.entries()].map(
          ([key, chunk]) => ({ key, chunk })
        );
        for (const item of this.drawSet) {
          this.drawChunk(gl, matrix, item);
        }
        this.syncVisibility();
      },

      onRemove(mapRef, gl) {
        this.clearTextures();
        if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
        if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
        if (this.program) gl.deleteProgram(this.program);
        this.gl = null;
      }
    };
  }

  function shouldShowDetail() {
    try {
      return (
        !isPlaying &&
        frames.length > 0 &&
        currentFrameIndex === frames.length - 1 &&
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
      const result = await originalShowFrame(...args);
      syncMode();
      return result;
    };

    const originalStartPlayback = startPlayback;
    startPlayback = async function (...args) {
      overlay?.setEnabled(false);
      radarLayer?.setVisible(radarVisible);
      return originalStartPlayback(...args);
    };

    const originalStopPlayback = stopPlayback;
    stopPlayback = function (...args) {
      const result = originalStopPlayback(...args);
      window.setTimeout(syncMode, 0);
      return result;
    };

    map.on("moveend", () => {
      syncMode();
      if (overlay?.enabled) overlay.updateWanted();
    });
    map.on("zoomend", () => {
      syncMode();
      if (overlay?.enabled) overlay.updateWanted();
    });

    opacityInput?.addEventListener(
      "input",
      () => overlay?.map?.triggerRepaint()
    );

    syncTimer = window.setInterval(syncMode, 500);
    pollTimer = window.setInterval(async () => {
      try {
        const next = await fetchManifest();
        if (next) overlay?.setManifest(next);
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
      },
      { once: true }
    );

    syncMode();
    console.info(
      "Main radar native-detail revision " +
        manifest.revision +
        " (" +
        manifest.nativeWidth +
        "x" +
        manifest.nativeHeight +
        ")"
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
        await install(manifest);
        return;
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
