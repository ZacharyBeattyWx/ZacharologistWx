(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const HOME_MODE = params.get("home") === "1";
  const STATIC_MANIFEST_URL = "./nexrad-static-pyramid-output/manifest.json";
  const LAYER_ID = "nexrad-main-live-static-overlay";
  const MAX_GPU_TILES = 96;
  const MAX_FETCHES = 8;
  const POLL_MS = 30000;
  const STARTED_AT = Date.now();
  const INSTALL_TIMEOUT_MS = 20000;

  let installed = false;
  let overlay = null;
  let pollTimer = null;
  let syncTimer = null;

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
        map && typeof map.addLayer === "function" &&
        typeof map.isStyleLoaded === "function" && map.isStyleLoaded() &&
        radarLayer &&
        Array.isArray(frames) && frames.length > 0
      );
    } catch (_) {
      return false;
    }
  }

  async function fetchManifest() {
    const response = await fetch(`${STATIC_MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Static NEXRAD manifest HTTP ${response.status}`);
    const manifest = await response.json();
    manifest._url = new URL(STATIC_MANIFEST_URL, window.location.href).href;
    return manifest;
  }

  async function bitmapFromUrl(url) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Static NEXRAD tile HTTP ${response.status}: ${url}`);
    const blob = await response.blob();
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      } catch (_) {
        return await createImageBitmap(blob);
      }
    }
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Static NEXRAD tile decode failed"));
      image.src = URL.createObjectURL(blob);
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    return texture;
  }

  function lngToTileX(lng, z) {
    const n = 2 ** z;
    return Math.floor((lng + 180) / 360 * n);
  }

  function latToTileY(lat, z) {
    const n = 2 ** z;
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const rad = clamped * Math.PI / 180;
    return Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * n);
  }

  function sourceTileZoom(mapZoom, manifest) {
    const min = Number(manifest.minZoom ?? 5);
    const max = Number(manifest.maxZoom ?? 7);
    let z;
    if (mapZoom >= 7.1) z = 7;
    else if (mapZoom >= 5.55) z = 6;
    else z = 5;
    return Math.max(min, Math.min(max, z));
  }

  function firstSymbolLayerId() {
    return (map.getStyle()?.layers || []).find(layer => layer.type === "symbol")?.id;
  }

  function createOverlay(initialManifest) {
    return {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "2d",
      manifest: initialManifest,
      enabled: false,
      tileCache: new Map(),
      pending: new Set(),
      queue: [],
      activeFetches: 0,
      wantedBase: new Map(),
      wantedDesired: new Map(),
      lastDrawSet: [],

      onAdd(mapRef, gl) {
        this.map = mapRef;
        this.gl = gl;
        const vs = compileShader(gl, gl.VERTEX_SHADER, `
          precision highp float;
          uniform mat4 u_matrix;
          attribute vec2 a_pos;
          attribute vec2 a_uv;
          varying vec2 v_uv;
          void main() {
            gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
            v_uv = a_uv;
          }
        `);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, `
          precision mediump float;
          uniform sampler2D u_texture;
          uniform float u_opacity;
          varying vec2 v_uv;
          void main() {
            vec4 radar = texture2D(u_texture, v_uv);
            gl_FragColor = vec4(radar.rgb, radar.a * u_opacity);
          }
        `);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(this.program) || "NEXRAD overlay shader link failed");
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

      manifestBase() {
        return new URL(".", this.manifest._url).href;
      },

      key(tile) {
        return `${this.manifest.revision}:${tile.z}/${tile.x}/${tile.y}`;
      },

      tileUrl(tile) {
        const relative = this.manifest.tileTemplate
          .replace("{z}", String(tile.z))
          .replace("{x}", String(tile.x))
          .replace("{y}", String(tile.y));
        return new URL(relative, this.manifestBase()).href;
      },

      visibleTilesAt(z) {
        const [westBound, southBound, eastBound, northBound] = this.manifest.bounds.map(Number);
        const n = 2 ** z;
        const bounds = this.map.getBounds();
        const west = Math.max(westBound, bounds.getWest());
        const east = Math.min(eastBound, bounds.getEast());
        const north = Math.min(northBound, bounds.getNorth());
        const south = Math.max(southBound, bounds.getSouth());
        if (west >= east || south >= north) return [];

        let x0 = Math.max(0, Math.min(n - 1, lngToTileX(west, z)));
        let x1 = Math.max(0, Math.min(n - 1, lngToTileX(east, z)));
        let y0 = Math.max(0, Math.min(n - 1, latToTileY(north, z)));
        let y1 = Math.max(0, Math.min(n - 1, latToTileY(south, z)));
        if (x0 > x1) [x0, x1] = [x1, x0];
        if (y0 > y1) [y0, y1] = [y1, y0];

        const tiles = [];
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
        }
        return tiles;
      },

      updateWanted() {
        if (!this.enabled) return;
        const baseZoom = Number(this.manifest.minZoom ?? 5);
        const desiredZoom = sourceTileZoom(this.map.getZoom(), this.manifest);
        const base = this.visibleTilesAt(baseZoom);
        const desired = this.visibleTilesAt(desiredZoom);
        this.wantedBase = new Map(base.map(tile => [this.key(tile), tile]));
        this.wantedDesired = new Map(desired.map(tile => [this.key(tile), tile]));
        this.queueTiles(base, 10);
        if (desiredZoom !== baseZoom) this.queueTiles(desired, 5);
        this.evict();
      },

      queueTiles(tiles, priority) {
        for (const tile of tiles) {
          const key = this.key(tile);
          if (this.tileCache.has(key) || this.pending.has(key)) continue;
          this.pending.add(key);
          this.queue.push({ tile, key, priority });
        }
        this.queue.sort((a, b) => b.priority - a.priority);
        this.pump();
      },

      async pump() {
        while (this.activeFetches < MAX_FETCHES && this.queue.length) {
          const item = this.queue.shift();
          if (this.tileCache.has(item.key)) {
            this.pending.delete(item.key);
            continue;
          }
          this.activeFetches += 1;
          this.fetchTile(item).finally(() => {
            this.activeFetches -= 1;
            this.pump();
          });
        }
      },

      async fetchTile(item) {
        try {
          const bitmap = await bitmapFromUrl(this.tileUrl(item.tile));
          if (!this.gl) return;
          const texture = createTexture(this.gl, bitmap);
          if (bitmap.close) bitmap.close();
          this.tileCache.set(item.key, {
            texture,
            tile: item.tile,
            lastUsed: performance.now()
          });
        } catch (error) {
          console.warn(`Main live NEXRAD tile ${item.key} failed`, error);
        } finally {
          this.pending.delete(item.key);
          this.evict();
          this.syncVisibility();
          this.map?.triggerRepaint();
        }
      },

      setManifest(next) {
        if (!next || next.revision === this.manifest.revision) return;
        this.manifest = next;
        this.queue = [];
        this.pending.clear();
        this.wantedBase = new Map();
        this.wantedDesired = new Map();
        this.lastDrawSet = [];
        if (this.enabled) this.updateWanted();
      },

      setEnabled(value) {
        this.enabled = Boolean(value);
        if (this.enabled) this.updateWanted();
        else this.syncVisibility();
        this.map?.triggerRepaint();
      },

      ready(tileMap) {
        return tileMap.size > 0 && [...tileMap.keys()].every(key => this.tileCache.has(key));
      },

      syncVisibility() {
        if (!this.enabled || !radarVisible) {
          radarLayer?.setVisible(radarVisible);
          return;
        }
        const sharpReady = this.ready(this.wantedDesired) || this.ready(this.wantedBase);
        if (HOME_MODE) {
          // Never flash the coarse MRMS live frame underneath the homepage radar.
          // Keep the basemap visible until a complete static NEXRAD set is ready.
          radarLayer?.setVisible(false);
        } else {
          radarLayer?.setVisible(!sharpReady && radarVisible);
        }
      },

      evict() {
        if (!this.gl || this.tileCache.size <= MAX_GPU_TILES) return;
        const protectedKeys = new Set([
          ...this.wantedBase.keys(),
          ...this.wantedDesired.keys(),
          ...this.lastDrawSet.map(item => item.key)
        ]);
        const removable = [...this.tileCache.entries()]
          .filter(([key]) => !protectedKeys.has(key))
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        while (this.tileCache.size > MAX_GPU_TILES && removable.length) {
          const [key, value] = removable.shift();
          this.gl.deleteTexture(value.texture);
          this.tileCache.delete(key);
        }
      },

      drawTile(gl, matrix, item) {
        const cached = this.tileCache.get(item.key);
        if (!cached?.texture) return;
        cached.lastUsed = performance.now();
        const tile = item.tile;
        const n = 2 ** tile.z;
        const x0 = tile.x / n, x1 = (tile.x + 1) / n;
        const y0 = tile.y / n, y1 = (tile.y + 1) / n;
        const positions = new Float32Array([
          x0,y0, x0,y1, x1,y0,
          x1,y0, x0,y1, x1,y1
        ]);
        const uv = new Float32Array([0,0, 0,1, 1,0, 1,0, 0,1, 1,1]);

        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uMatrix, false, matrix);
        gl.uniform1i(this.uTexture, 0);
        gl.uniform1f(this.uOpacity, Number(opacityInput?.value ?? 1));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.aUv);
        gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cached.texture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },

      render(gl, matrix) {
        if (!this.enabled || !radarVisible) return;
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        let draw = null;
        if (this.ready(this.wantedDesired)) {
          draw = [...this.wantedDesired.entries()].map(([key, tile]) => ({ key, tile }));
        } else if (this.ready(this.wantedBase)) {
          draw = [...this.wantedBase.entries()].map(([key, tile]) => ({ key, tile }));
        }
        if (draw?.length) {
          this.lastDrawSet = draw;
          for (const item of draw) this.drawTile(gl, matrix, item);
        }
        this.syncVisibility();
      },

      onRemove(mapRef, gl) {
        for (const value of this.tileCache.values()) {
          if (value.texture) gl.deleteTexture(value.texture);
        }
        if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
        if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
        if (this.program) gl.deleteProgram(this.program);
        this.gl = null;
      }
    };
  }

  function shouldShowLiveOverlay() {
    try {
      return !isPlaying && frames.length > 0 && currentFrameIndex === frames.length - 1 && radarVisible;
    } catch (_) {
      return false;
    }
  }

  function syncMode() {
    if (!overlay) return;
    const enabled = shouldShowLiveOverlay();
    overlay.setEnabled(enabled);
    if (!enabled) radarLayer?.setVisible(radarVisible);
  }

  async function install(manifest) {
    if (installed || !manifest || !ready()) return false;
    installed = true;
    if (HOME_MODE) radarLayer?.setVisible(false);
    overlay = createOverlay(manifest);
    const beforeId = firstSymbolLayerId();
    if (beforeId) map.addLayer(overlay, beforeId); else map.addLayer(overlay);

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
      if (overlay?.enabled) overlay.updateWanted();
    });
    map.on("zoomend", () => {
      if (overlay?.enabled) overlay.updateWanted();
    });

    opacityInput?.addEventListener("input", () => overlay?.map?.triggerRepaint());

    syncTimer = window.setInterval(syncMode, 500);
    pollTimer = window.setInterval(async () => {
      try {
        const next = await fetchManifest();
        if (next) overlay?.setManifest(next);
      } catch (error) {
        console.warn("Main live NEXRAD manifest refresh failed", error);
      }
    }, POLL_MS);

    window.addEventListener("beforeunload", () => {
      if (syncTimer) window.clearInterval(syncTimer);
      if (pollTimer) window.clearInterval(pollTimer);
    }, { once: true });

    syncMode();
    console.info(`Main radar live overlay: static NEXRAD revision ${manifest.revision}`);
    return true;
  }

  async function tryInstall() {
    if (installed) return;
    const elapsed = Date.now() - STARTED_AT;
    if (!ready()) {
      if (elapsed < INSTALL_TIMEOUT_MS) {
        window.setTimeout(tryInstall, 100);
      } else if (HOME_MODE && typeof radarLayer !== "undefined" && radarLayer) {
        radarLayer.setVisible(radarVisible);
        console.warn("Static NEXRAD startup timed out; restored MRMS fallback");
      }
      return;
    }
    try {
      const manifest = await fetchManifest();
      if (manifest) {
        await install(manifest);
        return;
      }
    } catch (error) {
      console.warn("Static NEXRAD live overlay unavailable", error);
    }
    if (Date.now() - STARTED_AT < INSTALL_TIMEOUT_MS) {
      window.setTimeout(tryInstall, 1000);
    } else if (HOME_MODE) {
      radarLayer?.setVisible(radarVisible);
      console.warn("Static NEXRAD manifest unavailable; restored MRMS fallback");
    }
  }

  tryInstall();
})();
