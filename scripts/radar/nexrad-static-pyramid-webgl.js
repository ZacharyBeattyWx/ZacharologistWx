(() => {
  "use strict";

  const MAPBOX_STYLE = "mapbox://styles/zacharybeattywx/cmpdipwzh00fq01sccdj806xy";
  const MANIFEST_URL = "./nexrad-static-pyramid-output/manifest.json";
  const LAYER_ID = "nexrad-static-python-colored";
  const MAX_GPU_TILES = 96;
  const MAX_FETCHES = 8;

  const statusText = document.getElementById("statusText");
  const statusDot = document.getElementById("statusDot");
  const modeTitle = document.getElementById("modeTitle");
  const modeDetail = document.getElementById("modeDetail");
  const detailBar = document.getElementById("detailBar");
  const zoomValue = document.getElementById("zoomValue");
  const detailInfo = document.getElementById("detailInfo");
  const nationalInfo = document.getElementById("nationalInfo");
  const tileInfo = document.getElementById("tileInfo");

  let radarLayer = null;

  function firstSymbolLayerId(map) {
    return (map.getStyle()?.layers || []).find(layer => layer.type === "symbol")?.id;
  }

  async function fetchManifest() {
    const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Static radar manifest HTTP ${response.status}`);
    const manifest = await response.json();
    manifest._url = new URL(MANIFEST_URL, window.location.href).href;
    return manifest;
  }

  async function waitForFirstManifest() {
    while (true) {
      try {
        const manifest = await fetchManifest();
        if (manifest) return manifest;
        statusDot.classList.remove("bad", "live");
        statusText.textContent = "Building first pre-rendered radar snapshot…";
        modeTitle.textContent = "Static radar build in progress";
        modeDetail.textContent = "Waiting for the first complete pyramid; this page will load it automatically.";
        detailInfo.textContent = "pre-rendering…";
        nationalInfo.textContent = "waiting for first revision";
      } catch (error) {
        console.warn("Waiting for static radar manifest", error);
        statusDot.classList.remove("bad", "live");
        statusText.textContent = "Waiting for static radar builder…";
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  async function bitmapFromUrl(url) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Static radar tile HTTP ${response.status}: ${url}`);
    const blob = await response.blob();
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      } catch (_) {
        return await createImageBitmap(blob);
      }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
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

  function createStaticRadarLayer(map, initialManifest) {
    return {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "2d",
      manifest: initialManifest,
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
          varying vec2 v_uv;
          void main() { gl_FragColor = texture2D(u_texture, v_uv); }
        `);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(this.program) || "program link failed");
        }

        this.aPos = gl.getAttribLocation(this.program, "a_pos");
        this.aUv = gl.getAttribLocation(this.program, "a_uv");
        this.uMatrix = gl.getUniformLocation(this.program, "u_matrix");
        this.uTexture = gl.getUniformLocation(this.program, "u_texture");
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

      queueTiles(tiles, priority = 0) {
        for (const tile of tiles) {
          const key = this.key(tile);
          if (this.tileCache.has(key) || this.pending.has(key)) continue;
          this.pending.add(key);
          this.queue.push({ tile, key, priority });
        }
        this.queue.sort((a, b) => b.priority - a.priority);
        this.pump();
      },

      updateWanted() {
        const baseZoom = Number(this.manifest.minZoom ?? 5);
        const desiredZoom = sourceTileZoom(this.map.getZoom(), this.manifest);
        const base = this.visibleTilesAt(baseZoom);
        const desired = this.visibleTilesAt(desiredZoom);
        this.wantedBase = new Map(base.map(tile => [this.key(tile), tile]));
        this.wantedDesired = new Map(desired.map(tile => [this.key(tile), tile]));
        this.queueTiles(base, 10);
        if (desiredZoom !== baseZoom) this.queueTiles(desired, 5);
        this.evict();
        this.updateUi();
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
            revision: this.manifest.revision,
            lastUsed: performance.now()
          });
        } catch (error) {
          console.warn(`Static NEXRAD tile ${item.key} failed`, error);
        } finally {
          this.pending.delete(item.key);
          this.evict();
          this.updateUi();
          this.map?.triggerRepaint();
        }
      },

      setManifest(next) {
        if (!next || next.revision === this.manifest.revision) return;
        console.info(`Static NEXRAD revision ${this.manifest.revision} -> ${next.revision}`);
        this.manifest = next;
        this.queue = [];
        this.pending.clear();
        this.updateWanted();
      },

      ready(mapOfTiles) {
        return mapOfTiles.size > 0 && [...mapOfTiles.keys()].every(key => this.tileCache.has(key));
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

      updateUi() {
        const zoom = this.map?.getZoom() ?? 0;
        zoomValue.textContent = zoom.toFixed(2);
        const desiredTotal = this.wantedDesired.size;
        const desiredLoaded = [...this.wantedDesired.keys()].filter(key => this.tileCache.has(key)).length;
        const baseTotal = this.wantedBase.size;
        const baseLoaded = [...this.wantedBase.keys()].filter(key => this.tileCache.has(key)).length;
        const pct = desiredTotal ? desiredLoaded / desiredTotal : (baseTotal ? baseLoaded / baseTotal : 0);
        detailBar.style.width = `${Math.round(pct * 100)}%`;

        const desiredZoom = sourceTileZoom(zoom, this.manifest);
        if (this.ready(this.wantedDesired)) {
          modeTitle.textContent = "Static high-resolution NEXRAD";
          modeDetail.textContent = `Pre-rendered z${desiredZoom} snapshot • zooming performs zero Python radar work.`;
        } else if (this.ready(this.wantedBase)) {
          modeTitle.textContent = "Refining static radar detail…";
          modeDetail.textContent = `${desiredLoaded}/${desiredTotal} z${desiredZoom} files loaded • showing pre-rendered z${this.manifest.minZoom} meanwhile.`;
        } else {
          modeTitle.textContent = "Loading static radar snapshot…";
          modeDetail.textContent = `${baseLoaded}/${baseTotal} base files loaded.`;
        }
        detailInfo.textContent = `${this.manifest.tileSize}px static Python RGBA • z${this.manifest.minZoom}–z${this.manifest.maxZoom}`;
        nationalInfo.textContent = `${this.manifest.revision} • ${this.manifest.sourceDataset || "N0B"}`;
        tileInfo.textContent = `${this.tileCache.size} GPU tiles • revision pre-rendered once per scan`;
      },

      render(gl, matrix) {
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        let draw = null;
        if (this.ready(this.wantedDesired)) {
          draw = [...this.wantedDesired.entries()].map(([key, tile]) => ({ key, tile }));
        } else if (this.ready(this.wantedBase)) {
          draw = [...this.wantedBase.entries()].map(([key, tile]) => ({ key, tile }));
        } else if (this.lastDrawSet.length) {
          draw = this.lastDrawSet;
        } else {
          draw = [...this.wantedBase.entries()]
            .filter(([key]) => this.tileCache.has(key))
            .map(([key, tile]) => ({ key, tile }));
        }

        if (draw?.length) {
          this.lastDrawSet = draw;
          for (const item of draw) this.drawTile(gl, matrix, item);
        }
        this.updateUi();
      },

      onRemove(mapRef, gl) {
        for (const value of this.tileCache.values()) if (value.texture) gl.deleteTexture(value.texture);
        if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
        if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
        if (this.program) gl.deleteProgram(this.program);
        this.gl = null;
      }
    };
  }

  async function init() {
    mapboxgl.accessToken = window.MAPBOX_PUBLIC_TOKEN;
    const map = new mapboxgl.Map({
      container: "map",
      style: MAPBOX_STYLE,
      center: [-96.0, 38.5],
      zoom: 4.4,
      minZoom: 2,
      maxZoom: 12,
      projection: "mercator"
    });
    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

    map.on("load", async () => {
      try {
        map.setProjection("mercator");
        const manifest = await waitForFirstManifest();
        statusDot.classList.remove("bad");
        statusDot.classList.add("live");
        statusText.textContent = "Static Python-colored radar pyramid ready";
        radarLayer = createStaticRadarLayer(map, manifest);
        map.addLayer(radarLayer, firstSymbolLayerId(map));
        radarLayer.updateWanted();

        map.on("moveend", () => radarLayer.updateWanted());
        map.on("zoomend", () => radarLayer.updateWanted());
        map.on("zoom", () => radarLayer.updateUi());

        setInterval(async () => {
          try {
            const next = await fetchManifest();
            if (next) radarLayer.setManifest(next);
          } catch (error) {
            console.warn("Static radar manifest refresh failed", error);
          }
        }, 30000);
      } catch (error) {
        console.error(error);
        statusDot.classList.add("bad");
        statusText.textContent = `Static radar load failed: ${error.message}`;
        modeTitle.textContent = "Build static radar first";
        modeDetail.textContent = "Run watch_nexrad_static_pyramid.py or build_nexrad_static_pyramid.py.";
      }
    });
  }

  init();
})();
