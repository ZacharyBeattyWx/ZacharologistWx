(function () {
  "use strict";

  const DEFAULT_LAYER_ID = "level2-manual-radar-layer";
  const DEFAULT_PREFETCH_PADDING = 1;
  const DEFAULT_MAX_VISIBLE_TILES = 2000;
  const DEFAULT_TILE_TIMEOUT_MS = 2200;
  const DEFAULT_CACHE_LIMIT = 5000;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lonToTileX(lon, zoom) {
    return Math.floor(((Number(lon) + 180) / 360) * Math.pow(2, zoom));
  }

  function latToTileY(lat, zoom) {
    const latRad = Number(lat) * Math.PI / 180;
    return Math.floor(
      (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom)
    );
  }

  function tileXToLon(x, zoom) {
    return x / Math.pow(2, zoom) * 360 - 180;
  }

  function tileYToLat(y, zoom) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, zoom);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function clampTile(value, zoom) {
    const maxTile = Math.pow(2, zoom) - 1;
    return clamp(value, 0, maxTile);
  }

  function minuteCacheBustUrl(url) {
    const separator = String(url).includes("?") ? "&" : "?";
    return `${url}${separator}v=${Math.floor(Date.now() / 60000)}`;
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

  function tileUrlForFrame(frame, zoom, x, y) {
    if (!frame?.tileTemplate) return null;
    return minuteCacheBustUrl(frame.tileTemplate)
      .replace("{z}", String(zoom))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }

  class Level2RadarEngine {
    constructor(options = {}) {
      this.map = options.map;
      this.layerId = options.layerId || DEFAULT_LAYER_ID;
      this.beforeLayerId = options.beforeLayerId || (() => undefined);
      this.status = options.status || (() => {});
      this.opacity = Number.isFinite(options.opacity) ? options.opacity : 1;

      this.prefetchPadding = options.prefetchPadding ?? DEFAULT_PREFETCH_PADDING;
      this.maxVisibleTiles = options.maxVisibleTiles ?? DEFAULT_MAX_VISIBLE_TILES;
      this.tileTimeoutMs = options.tileTimeoutMs ?? DEFAULT_TILE_TIMEOUT_MS;
      this.cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;

      this.frames = [];
      this.currentFrameIndex = -1;
      this.currentTileKeys = [];
      this.tileCache = new Map();
      this.textureCache = new Map();

      this.gl = null;
      this.program = null;
      this.positionBuffer = null;
      this.texCoordBuffer = null;
      this.aPos = -1;
      this.aTex = -1;
      this.uMatrix = null;
      this.uTexture = null;
      this.uOpacity = null;

      this.customLayer = {
        id: this.layerId,
        type: "custom",
        renderingMode: "2d",
        onAdd: (_map, gl) => this.onAdd(gl),
        render: (gl, matrix) => this.render(gl, matrix)
      };
    }

    isEnabled() {
      return !!this.map;
    }

    addToMap() {
      if (!this.map || this.map.getLayer(this.layerId)) return;
      this.map.addLayer(this.customLayer, this.beforeLayerId());
      this.map.triggerRepaint();
    }

    removeFromMap() {
      if (!this.map) return;
      if (this.map.getLayer(this.layerId)) this.map.removeLayer(this.layerId);
      this.tileCache.clear();
      this.textureCache.clear();
      this.currentTileKeys = [];
      this.currentFrameIndex = -1;
    }

    setOpacity(value) {
      this.opacity = clamp(Number(value), 0, 1);
      this.map?.triggerRepaint();
    }

    setFrames(frames) {
      this.frames = Array.isArray(frames) ? frames : [];
      if (!this.frames.length) {
        this.currentFrameIndex = -1;
        this.currentTileKeys = [];
      } else {
        this.currentFrameIndex = clamp(this.currentFrameIndex, 0, this.frames.length - 1);
      }
      this.trimCaches();
    }

    async setFrame(frameIndex) {
      if (!this.frames.length) return false;

      const index = ((frameIndex % this.frames.length) + this.frames.length) % this.frames.length;
      const frame = this.frames[index];

      this.addToMap();
      this.status(`warming radar engine frame ${index + 1}/${this.frames.length}`);

      const tileKeys = await this.prefetchVisibleFrame(frame, index);

      // Do not switch the active frame until the engine has finished its own readiness pass.
      this.currentFrameIndex = index;
      this.currentTileKeys = tileKeys;
      this.status(`manual radar engine ready ${index + 1}/${this.frames.length}`);
      this.map?.triggerRepaint();

      return true;
    }

    async prefetchVisibleFrame(frame, frameIndex) {
      const tiles = this.visibleTilesForFrame(frame);
      const keys = [];

      const jobs = tiles.map(async (tile) => {
        const key = this.tileKey(frameIndex, tile.z, tile.x, tile.y);
        keys.push(key);
        if (this.tileCache.has(key)) return;

        const image = await this.loadTile(tile.url);
        this.tileCache.set(key, {
          ...tile,
          frameIndex,
          image,
          failed: !image
        });
      });

      await Promise.allSettled(jobs);
      this.trimCaches();
      return keys;
    }

    visibleTilesForFrame(frame) {
      if (!this.map || !frame?.tileTemplate) return [];

      const mapBounds = this.map.getBounds();
      const radarBounds = frameBounds(frame);
      if (!mapBounds || !radarBounds) return [];

      const west = Math.max(mapBounds.getWest(), radarBounds.west);
      const east = Math.min(mapBounds.getEast(), radarBounds.east);
      const south = Math.max(mapBounds.getSouth(), radarBounds.south);
      const north = Math.min(mapBounds.getNorth(), radarBounds.north);

      if (east <= west || north <= south) return [];

      const tileMinZoom = Number.isFinite(frame.tileMinZoom) ? frame.tileMinZoom : 5;
      const tileMaxZoom = Number.isFinite(frame.tileMaxZoom) ? frame.tileMaxZoom : 10;
      const padding = this.prefetchPadding;

      const buildTilesForZoom = (z) => {
        let xMin = clampTile(lonToTileX(west, z) - padding, z);
        let xMax = clampTile(lonToTileX(east, z) + padding, z);
        let yMin = clampTile(latToTileY(north, z) - padding, z);
        let yMax = clampTile(latToTileY(south, z) + padding, z);

        if (xMax < xMin) [xMin, xMax] = [xMax, xMin];
        if (yMax < yMin) [yMin, yMax] = [yMax, yMin];

        const centerX = (xMin + xMax) / 2;
        const centerY = (yMin + yMax) / 2;
        const tiles = [];

        for (let x = xMin; x <= xMax; x += 1) {
          for (let y = yMin; y <= yMax; y += 1) {
            if (!this.tileExistsInFrameIndex(frame, z, x, y)) continue;

            const url = tileUrlForFrame(frame, z, x, y);
            if (!url) continue;

            tiles.push({
              z,
              x,
              y,
              url,
              west: tileXToLon(x, z),
              east: tileXToLon(x + 1, z),
              north: tileYToLat(y, z),
              south: tileYToLat(y + 1, z),
              distance: Math.hypot(x - centerX, y - centerY)
            });
          }
        }

        tiles.sort((a, b) => a.distance - b.distance);
        return tiles;
      };

      // Quality-first strategy:
      // Prefer the highest rendered radar tile zoom, usually z10, so radar stays crisp.
      // Fall back only if the visible/indexed tile count exceeds the engine budget.
      for (let z = tileMaxZoom; z >= tileMinZoom; z -= 1) {
        const candidateTiles = buildTilesForZoom(z);
        if (!candidateTiles.length) continue;

        if (candidateTiles.length <= this.maxVisibleTiles || z === tileMinZoom) {
          this.activeTileZoom = z;
          return candidateTiles;
        }
      }

      this.activeTileZoom = null;
      return [];
    }

    loadTile(url) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";

        let settled = false;
        const finish = (image) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          img.onload = null;
          img.onerror = null;
          resolve(image);
        };

        const timeoutId = window.setTimeout(() => finish(null), this.tileTimeoutMs);

        img.onload = () => {
          if (typeof img.decode === "function") {
            img.decode().then(() => finish(img)).catch(() => finish(img));
          } else {
            finish(img);
          }
        };

        // Missing radar tiles should not blank the whole frame.
        img.onerror = () => finish(null);
        img.src = url;
      });
    }

    tileKey(frameIndex, z, x, y) {
      return `${frameIndex}:${z}:${x}:${y}`;
    }

    tileExistsInFrameIndex(frame, z, x, y) {
      // New manifests include the exact static PNG tiles that exist for each frame.
      // If tileIndex is absent, fall back to the visible grid for backward compatibility.
      if (!frame?.tileIndex) return true;

      const zoomKey = String(z);
      const zoomTiles = frame.tileIndex[zoomKey];
      if (!Array.isArray(zoomTiles)) return false;

      if (!frame.__tileIndexSets) frame.__tileIndexSets = {};
      if (!frame.__tileIndexSets[zoomKey]) {
        frame.__tileIndexSets[zoomKey] = new Set(zoomTiles);
      }

      return frame.__tileIndexSets[zoomKey].has(`${x}/${y}`);
    }

    trimCaches() {
      while (this.tileCache.size > this.cacheLimit) {
        const key = this.tileCache.keys().next().value;
        if (!key) break;
        this.deleteTileKey(key);
      }
    }

    deleteTileKey(key) {
      this.tileCache.delete(key);
      const texture = this.textureCache.get(key);
      if (texture && this.gl) this.gl.deleteTexture(texture);
      this.textureCache.delete(key);
    }

    onAdd(gl) {
      this.gl = gl;

      const vertexShader = this.compileShader(gl, gl.VERTEX_SHADER, `
        attribute vec2 a_pos;
        attribute vec2 a_tex;
        uniform mat4 u_matrix;
        varying vec2 v_tex;
        void main() {
          gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
          v_tex = a_tex;
        }
      `);

      const fragmentShader = this.compileShader(gl, gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D u_texture;
        uniform float u_opacity;
        varying vec2 v_tex;
        void main() {
          vec4 color = texture2D(u_texture, v_tex);
          gl_FragColor = vec4(color.rgb, color.a * u_opacity);
        }
      `);

      this.program = gl.createProgram();
      gl.attachShader(this.program, vertexShader);
      gl.attachShader(this.program, fragmentShader);
      gl.linkProgram(this.program);

      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        throw new Error(`Level II radar engine shader link failed: ${gl.getProgramInfoLog(this.program)}`);
      }

      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      this.aPos = gl.getAttribLocation(this.program, "a_pos");
      this.aTex = gl.getAttribLocation(this.program, "a_tex");
      this.uMatrix = gl.getUniformLocation(this.program, "u_matrix");
      this.uTexture = gl.getUniformLocation(this.program, "u_texture");
      this.uOpacity = gl.getUniformLocation(this.program, "u_opacity");

      this.positionBuffer = gl.createBuffer();
      this.texCoordBuffer = gl.createBuffer();
    }

    compileShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);

      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Level II radar engine shader compile failed: ${message}`);
      }

      return shader;
    }

    textureForTile(key, tile) {
      if (!tile?.image || !this.gl) return null;
      if (this.textureCache.has(key)) return this.textureCache.get(key);

      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // LINEAR filtering reduces harsh blockiness while keeping the tiled radar locked to the map.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile.image);

      this.textureCache.set(key, texture);
      return texture;
    }

    mercatorPoint(lon, lat) {
      return mapboxgl.MercatorCoordinate.fromLngLat({ lng: lon, lat });
    }

    render(gl, matrix) {
      if (!this.program || !this.currentTileKeys.length) {
        this.map?.triggerRepaint();
        return;
      }

      gl.useProgram(this.program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);

      gl.uniformMatrix4fv(this.uMatrix, false, matrix);
      gl.uniform1i(this.uTexture, 0);
      gl.uniform1f(this.uOpacity, this.opacity);

      for (const key of this.currentTileKeys) {
        const tile = this.tileCache.get(key);
        if (!tile || tile.failed || !tile.image) continue;

        const texture = this.textureForTile(key, tile);
        if (!texture) continue;

        const nw = this.mercatorPoint(tile.west, tile.north);
        const ne = this.mercatorPoint(tile.east, tile.north);
        const se = this.mercatorPoint(tile.east, tile.south);
        const sw = this.mercatorPoint(tile.west, tile.south);

        const positions = new Float32Array([
          nw.x, nw.y,
          ne.x, ne.y,
          se.x, se.y,
          nw.x, nw.y,
          se.x, se.y,
          sw.x, sw.y
        ]);

        const texCoords = new Float32Array([
          0, 0,
          1, 0,
          1, 1,
          0, 0,
          1, 1,
          0, 1
        ]);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STREAM_DRAW);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STREAM_DRAW);
        gl.enableVertexAttribArray(this.aTex);
        gl.vertexAttribPointer(this.aTex, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      gl.enable(gl.DEPTH_TEST);
      this.map?.triggerRepaint();
    }
  }

  window.Level2RadarEngine = Level2RadarEngine;
})();
