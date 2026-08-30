(() => {
  "use strict";

  const MAPBOX_STYLE = "mapbox://styles/zacharybeattywx/cmpdipwzh00fq01sccdj806xy";
  const NATIONAL_MANIFEST = "./unidata-nexrad-mosaic-output/manifest.json";
  const LAYER_ID = "nexrad-freezoom-python-colored";
  const DETAIL_SWITCH_ZOOM = 6.25;
  const PAGE_SESSION = Date.now();
  const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const DETAIL_SERVER = IS_LOCAL ? `http://${location.hostname}:8010` : (window.ZWX_NEXRAD_TILE_SERVER || "");
  const MAX_GPU_TILES = 96;
  const MAX_FETCHES = 6;

  const statusText = document.getElementById("statusText");
  const statusDot = document.getElementById("statusDot");
  const modeTitle = document.getElementById("modeTitle");
  const modeDetail = document.getElementById("modeDetail");
  const detailBar = document.getElementById("detailBar");
  const zoomValue = document.getElementById("zoomValue");
  const detailInfo = document.getElementById("detailInfo");
  const nationalInfo = document.getElementById("nationalInfo");
  const tileInfo = document.getElementById("tileInfo");

  let tileServerOnline = false;
  let latestStatus = null;
  let radarLayer = null;

  function firstSymbolLayerId(map) {
    return (map.getStyle()?.layers || []).find(layer => layer.type === "symbol")?.id;
  }

  async function fetchManifest(url) {
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
    const manifest = await response.json();
    manifest._url = new URL(url, window.location.href).href;
    return manifest;
  }

  async function bitmapFromUrl(url) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Radar image HTTP ${response.status}`);
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

  async function checkTileServer() {
    if (!DETAIL_SERVER) {
      tileServerOnline = false;
      statusDot.classList.add("bad");
      statusText.textContent = "Detail server not configured; national fallback only";
      detailInfo.textContent = "offline";
      return null;
    }
    try {
      const response = await fetch(`${DETAIL_SERVER}/status.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      latestStatus = data;
      tileServerOnline = !!data.ok;
      statusDot.classList.toggle("live", tileServerOnline);
      statusDot.classList.toggle("bad", !tileServerOnline);
      statusText.textContent = tileServerOnline ? "Python-colored free-zoom renderer ready" : "Detail server unavailable";
      detailInfo.textContent = tileServerOnline ? `${data.tileSize}px Python RGBA tiles • ${data.stationCount} stations` : "offline";
      tileInfo.textContent = `${data.cachedTiles || 0} server tiles • ${data.cachedSites || 0} sites cached`;
      radarLayer?.setServerOnline(tileServerOnline);
      return data;
    } catch (error) {
      tileServerOnline = false;
      statusDot.classList.remove("live");
      statusDot.classList.add("bad");
      statusText.textContent = "Start serve_nexrad_detail_tiles.py for sharp zoom";
      detailInfo.textContent = "server offline";
      radarLayer?.setServerOnline(false);
      return null;
    }
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

  function tileBounds(z, x, y) {
    const n = 2 ** z;
    const west = x / n * 360 - 180;
    const east = (x + 1) / n * 360 - 180;
    const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
    return [west, south, east, north];
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

  function sourceTileZoom(mapZoom) {
    // Progressive LOD: get useful detail quickly, then refine only after the
    // next complete viewport is ready. The currently displayed LOD stays put
    // during the camera zoom, so there is no tile-pyramid rebuild under the user.
    if (mapZoom >= 8.75) return 9;  // ~120 m rendered pixels
    if (mapZoom >= 7.45) return 8;  // ~240 m rendered pixels
    return 7;                       // ~480 m rendered pixels
  }

  function createPythonColoredFreeZoomLayer(map, nationalBitmap, nationalBounds) {
    const [nationalWest, nationalSouth, nationalEast, nationalNorth] = nationalBounds.map(Number);

    return {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "2d",
      serverOnline: tileServerOnline,
      tileCache: new Map(),
      pending: new Set(),
      wanted: new Map(),
      displayed: new Map(),
      displayedZoom: null,
      fetchQueue: [],
      activeFetches: 0,
      sequence: 0,

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
          void main() {
            gl_FragColor = texture2D(u_texture, v_uv);
          }
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
        this.nationalTexture = createTexture(gl, nationalBitmap);

        this.updateWantedTiles();
      },

      setServerOnline(value) {
        this.serverOnline = !!value;
        this.updateWantedTiles();
        this.map?.triggerRepaint();
      },

      tileKey(z, x, y) {
        return `${z}/${x}/${y}`;
      },

      visibleTilesAt(z) {
        if (!this.serverOnline || this.map.getZoom() < DETAIL_SWITCH_ZOOM) return [];
        const n = 2 ** z;
        const bounds = this.map.getBounds();
        const west = Math.max(-179.999, bounds.getWest());
        const east = Math.min(179.999, bounds.getEast());
        const north = Math.min(85.0, bounds.getNorth());
        const south = Math.max(-85.0, bounds.getSouth());

        let x0 = lngToTileX(west, z) - 1;
        let x1 = lngToTileX(east, z) + 1;
        let y0 = latToTileY(north, z) - 1;
        let y1 = latToTileY(south, z) + 1;
        x0 = Math.max(0, x0); x1 = Math.min(n - 1, x1);
        y0 = Math.max(0, y0); y1 = Math.min(n - 1, y1);

        const tiles = [];
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const [tw, ts, te, tn] = tileBounds(z, x, y);
            if (te <= nationalWest || tw >= nationalEast || tn <= nationalSouth || ts >= nationalNorth) continue;
            tiles.push({ z, x, y, key: this.tileKey(z, x, y) });
          }
        }
        return tiles;
      },

      visibleTiles() {
        return this.visibleTilesAt(sourceTileZoom(this.map.getZoom()));
      },

      updateWantedTiles() {
        const tiles = this.visibleTiles();
        this.wanted = new Map(tiles.map(tile => [tile.key, tile]));
        this.sequence += 1;
        const seq = this.sequence;

        for (const tile of tiles) {
          const cached = this.tileCache.get(tile.key);
          if (cached) {
            cached.lastUsed = performance.now();
            continue;
          }
          if (this.pending.has(tile.key)) continue;
          this.pending.add(tile.key);
          this.fetchQueue.push({ ...tile, seq });
        }
        this.pumpFetchQueue();
        this.evictOldTiles();
        this.updateUi();
      },

      async pumpFetchQueue() {
        while (this.activeFetches < MAX_FETCHES && this.fetchQueue.length) {
          const tile = this.fetchQueue.shift();
          if (!this.wanted.has(tile.key) && tile.seq !== this.sequence) {
            this.pending.delete(tile.key);
            continue;
          }
          this.activeFetches += 1;
          this.fetchTile(tile).finally(() => {
            this.activeFetches -= 1;
            this.pumpFetchQueue();
          });
        }
      },

      async fetchTile(tile) {
        try {
          const url = `${DETAIL_SERVER}/tiles/${tile.z}/${tile.x}/${tile.y}.webp?session=${PAGE_SESSION}`;
          const bitmap = await bitmapFromUrl(url);
          if (!this.gl) return;
          const texture = createTexture(this.gl, bitmap);
          if (bitmap.close) bitmap.close();
          const old = this.tileCache.get(tile.key);
          if (old?.texture) this.gl.deleteTexture(old.texture);
          this.tileCache.set(tile.key, {
            texture,
            z: tile.z,
            x: tile.x,
            y: tile.y,
            lastUsed: performance.now()
          });
        } catch (error) {
          console.warn(`NEXRAD detail tile ${tile.key} failed`, error);
        } finally {
          this.pending.delete(tile.key);
          this.evictOldTiles();
          this.updateUi();
          this.map?.triggerRepaint();
        }
      },

      evictOldTiles() {
        if (!this.gl || this.tileCache.size <= MAX_GPU_TILES) return;
        const removable = [...this.tileCache.entries()]
          .filter(([key]) => !this.wanted.has(key) && !this.displayed.has(key))
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        while (this.tileCache.size > MAX_GPU_TILES && removable.length) {
          const [key, value] = removable.shift();
          this.gl.deleteTexture(value.texture);
          this.tileCache.delete(key);
        }
      },

      nationalUvForBounds(west, south, east, north) {
        return {
          u0: (west - nationalWest) / (nationalEast - nationalWest),
          u1: (east - nationalWest) / (nationalEast - nationalWest),
          v0: (nationalNorth - north) / (nationalNorth - nationalSouth),
          v1: (nationalNorth - south) / (nationalNorth - nationalSouth)
        };
      },

      drawQuad(gl, matrix, texture, positions, uv) {
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
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },

      drawNationalFull(gl, matrix) {
        const nw = mapboxgl.MercatorCoordinate.fromLngLat([nationalWest, nationalNorth]);
        const sw = mapboxgl.MercatorCoordinate.fromLngLat([nationalWest, nationalSouth]);
        const ne = mapboxgl.MercatorCoordinate.fromLngLat([nationalEast, nationalNorth]);
        const se = mapboxgl.MercatorCoordinate.fromLngLat([nationalEast, nationalSouth]);
        const positions = new Float32Array([
          nw.x,nw.y, sw.x,sw.y, ne.x,ne.y,
          ne.x,ne.y, sw.x,sw.y, se.x,se.y
        ]);
        const uv = new Float32Array([0,0, 0,1, 1,0, 1,0, 0,1, 1,1]);
        this.drawQuad(gl, matrix, this.nationalTexture, positions, uv);
      },

      drawTileCell(gl, matrix, tile) {
        const n = 2 ** tile.z;
        const x0 = tile.x / n;
        const x1 = (tile.x + 1) / n;
        const y0 = tile.y / n;
        const y1 = (tile.y + 1) / n;
        const positions = new Float32Array([
          x0,y0, x0,y1, x1,y0,
          x1,y0, x0,y1, x1,y1
        ]);

        const cached = this.tileCache.get(tile.key);
        if (cached?.texture) {
          cached.lastUsed = performance.now();
          const uv = new Float32Array([0,0, 0,1, 1,0, 1,0, 0,1, 1,1]);
          this.drawQuad(gl, matrix, cached.texture, positions, uv);
          return;
        }

        const [west, south, east, north] = tileBounds(tile.z, tile.x, tile.y);
        const crop = this.nationalUvForBounds(west, south, east, north);
        const uv = new Float32Array([
          crop.u0,crop.v0, crop.u0,crop.v1, crop.u1,crop.v0,
          crop.u1,crop.v0, crop.u0,crop.v1, crop.u1,crop.v1
        ]);
        this.drawQuad(gl, matrix, this.nationalTexture, positions, uv);
      },

      updateUi() {
        const z = this.map?.getZoom() ?? 0;
        zoomValue.textContent = z.toFixed(2);
        const tiles = [...this.wanted.values()];
        const loaded = tiles.filter(tile => this.tileCache.has(tile.key)).length;
        const total = tiles.length;
        const pct = total ? loaded / total : 0;
        const progress = z < DETAIL_SWITCH_ZOOM ? 0 : pct;
        detailBar.style.width = `${Math.round(progress * 100)}%`;

        if (!this.serverOnline) {
          modeTitle.textContent = "National 1-km mosaic";
          modeDetail.textContent = "High-resolution Python tile server is offline.";
        } else if (z < DETAIL_SWITCH_ZOOM) {
          modeTitle.textContent = "National 1-km mosaic";
          modeDetail.textContent = "Zoom in normally — no region selection required.";
        } else if (loaded < total) {
          modeTitle.textContent = this.displayedZoom !== null ? "Refining radar detail…" : "Loading Python-colored radar detail…";
          modeDetail.textContent = `${loaded}/${total} z${sourceTileZoom(z)} tiles ready${this.displayedZoom !== null ? ` • showing z${this.displayedZoom} meanwhile` : ""}`;
        } else {
          modeTitle.textContent = "Free-zoom native NEXRAD detail";
          modeDetail.textContent = `Python-colored z${this.displayedZoom ?? sourceTileZoom(z)} detail • Mapbox only positions the texture.`;
        }
      },

      render(gl, matrix) {
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        const zoom = this.map.getZoom();
        if (!this.serverOnline || zoom < DETAIL_SWITCH_ZOOM) {
          this.drawNationalFull(gl, matrix);
          this.updateUi();
          return;
        }

        // Freeze the radar source set while the camera is actively zooming.
        // The already-loaded texture simply scales with Mapbox's geographic matrix.
        if (!this.map.isZooming()) {
          const current = this.visibleTiles();
          const currentKey = current.map(t => t.key).join("|");
          const wantedKey = [...this.wanted.keys()].join("|");
          if (currentKey !== wantedKey) this.updateWantedTiles();
        }

        const desired = [...this.wanted.values()];
        const desiredReady = desired.length > 0 &&
          desired.every(tile => this.tileCache.has(tile.key));

        if (desiredReady) {
          // Atomic promotion: the new LOD becomes visible only when the entire
          // viewport is ready. No checkerboard of parent/child/fallback tiles.
          this.displayed = new Map(desired.map(tile => [tile.key, tile]));
          this.displayedZoom = desired[0].z;
        }

        let drawTiles = null;
        if (desiredReady) {
          drawTiles = desired;
        } else if (this.displayedZoom !== null) {
          // Keep the previous complete LOD on screen while the finer LOD loads.
          // This is the key to retaining sharpness during z7 -> z8 -> z9 refinement.
          const fallback = this.visibleTilesAt(this.displayedZoom);
          const fallbackReady = fallback.length > 0 &&
            fallback.every(tile => this.tileCache.has(tile.key));
          if (fallbackReady) drawTiles = fallback;
        }

        if (!drawTiles) {
          // A pan can expose uncached territory. Until one complete detail set is
          // ready for the new viewport, use one continuous national surface rather
          // than mixing coarse and fine rectangles.
          this.drawNationalFull(gl, matrix);
          this.updateUi();
          return;
        }

        for (const tile of drawTiles) this.drawTileCell(gl, matrix, tile);
        this.updateUi();
      },

      onRemove(mapRef, gl) {
        if (this.nationalTexture) gl.deleteTexture(this.nationalTexture);
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
        const nationalManifest = await fetchManifest(NATIONAL_MANIFEST);
        const nationalUrl = new URL(nationalManifest.image, nationalManifest._url).href + `?rev=${nationalManifest.revision || PAGE_SESSION}`;
        const nationalBitmap = await bitmapFromUrl(nationalUrl);
        nationalInfo.textContent = `${nationalManifest.imageWidth}×${nationalManifest.imageHeight} ${nationalManifest.product || "N0B"}`;

        await checkTileServer();
        radarLayer = createPythonColoredFreeZoomLayer(map, nationalBitmap, nationalManifest.bounds);
        map.addLayer(radarLayer, firstSymbolLayerId(map));
        radarLayer.setServerOnline(tileServerOnline);

        map.on("moveend", () => {
          radarLayer.updateWantedTiles();
          if (tileServerOnline) setTimeout(checkTileServer, 100);
        });
        map.on("zoomend", () => radarLayer.updateWantedTiles());
        map.on("zoom", () => radarLayer.updateUi());
      } catch (error) {
        console.error(error);
        statusDot.classList.add("bad");
        statusText.textContent = `Load failed: ${error.message}`;
      }
    });

    setInterval(() => {
      if (tileServerOnline) checkTileServer();
    }, 15000);
  }

  init();
})();
