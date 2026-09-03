(() => {
  "use strict";

  const DETAIL_MANIFEST_URL =
    "https://dt0cd6bl1yqh2.cloudfront.net/mrms-detail/manifest.json";
  const LAYER_ID = "mrms-native-detail-overlay";

  // Hysteresis prevents touch/pinch zoom from rapidly bouncing between LODs.
  const ENTER_DETAIL_ZOOM = 4.8;
  const EXIT_DETAIL_ZOOM = 4.35;

  const MOBILE_DEVICE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const MAX_GPU_TEXTURE_BYTES =
    (MOBILE_DEVICE ? 160 : 384) * 1024 * 1024;
  const MAX_GPU_CHUNKS = MOBILE_DEVICE ? 72 : 160;
  const MAX_FETCHES = MOBILE_DEVICE ? 2 : 4;
  const FAST_FETCHES = MOBILE_DEVICE ? 3 : 6;
  const VIEWPORT_SYNC_MS = MOBILE_DEVICE ? 120 : 75;
  const VIEWPORT_OVERSCAN = MOBILE_DEVICE ? 0.22 : 0.28;
  const POLL_MS = 30000;
  const STARTED_AT = Date.now();
  const INSTALL_TIMEOUT_MS = 20000;
  const LATITUDE_SEGMENTS = 64;

  let installed = false;
  let overlay = null;
  let detailArchive = null;
  let detailMode = false;
  let leavingDetail = false;
  let baseTextureFrameId = "";
  let baseSyncBusy = false;
  let pollTimer = null;
  let retryTimer = null;
  let viewportTimer = null;
  let lastViewportSyncAt = 0;

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
        typeof primePlaybackBuffer === "function" &&
        typeof updateFrameUi === "function" &&
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

    if (response.status === 403 || response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        "Native MRMS detail manifest HTTP " + response.status
      );
    }

    const manifest = await response.json();
    const singleFrame =
      manifest.mode === "native-grid-chunks" &&
      Array.isArray(manifest.chunks) &&
      manifest.chunks.length > 0;
    const archive =
      manifest.mode === "native-grid-chunk-archive" &&
      Array.isArray(manifest.frames) &&
      typeof manifest.imageTemplate === "string" &&
      (
        Array.isArray(manifest.chunkLayout) ||
        (
          manifest.layouts &&
          typeof manifest.layouts === "object"
        )
      );

    if (!singleFrame && !archive) {
      throw new Error(
        "Native MRMS detail manifest is incomplete"
      );
    }

    manifest._url = DETAIL_MANIFEST_URL;
    return manifest;
  }

  function frameIdAt(index = currentFrameIndex) {
    return String(frames?.[index]?.id || "");
  }

  function frameIndexForId(frameId) {
    return frames.findIndex(
      frame => String(frame?.id || "") === String(frameId)
    );
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

    if (!chunkLayout.length) return null;

    const chunks = chunkLayout.map(layout => {
      const image = archive.imageTemplate
        .replace("{revision}", String(frame.revision))
        .replace("{chunkId}", String(layout.id));
      return {
        ...layout,
        image
      };
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

  function nativeFrameExists(frameId) {
    return Boolean(
      frameManifestFromArchive(
        detailArchive,
        frameId
      )
    );
  }

  function currentPlaybackSpeed() {
    try {
      if (typeof speedSelect !== "undefined") {
        return Math.max(
          0.25,
          Number(speedSelect.value) || 1
        );
      }
    } catch (_) {}
    return 1;
  }

  function normalizeIndex(index) {
    if (!frames.length) return 0;
    return (
      (
        Number(index) % frames.length
      ) + frames.length
    ) % frames.length;
  }

  function nextNativeIndex(index) {
    if (!frames.length) return -1;

    const start = normalizeIndex(index);
    for (
      let offset = 0;
      offset < frames.length;
      offset += 1
    ) {
      const candidate =
        (start + offset) % frames.length;
      if (nativeFrameExists(frameIdAt(candidate))) {
        return candidate;
      }
    }
    return -1;
  }

  async function bitmapFromUrl(
    url,
    signal = undefined
  ) {
    const response = await fetch(url, {
      cache: "force-cache",
      signal
    });

    if (!response.ok) {
      throw new Error(
        "Native MRMS detail chunk HTTP " +
          response.status +
          ": " +
          url
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

    return await new Promise(
      (resolve, reject) => {
        const image = new Image();
        const objectUrl =
          URL.createObjectURL(blob);
        image.decoding = "async";

        image.onload = () => {
          URL.revokeObjectURL(objectUrl);
          resolve(image);
        };

        image.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(
            new Error(
              "Native MRMS detail chunk decode failed"
            )
          );
        };

        image.src = objectUrl;
      }
    );
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (
      !gl.getShaderParameter(
        shader,
        gl.COMPILE_STATUS
      )
    ) {
      const message =
        gl.getShaderInfoLog(shader) ||
        "shader compile failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }

    return shader;
  }

  function createTexture(gl, image) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

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

    gl.pixelStorei(
      gl.UNPACK_FLIP_Y_WEBGL,
      false
    );
    gl.pixelStorei(
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      false
    );

    if (
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !==
      undefined
    ) {
      gl.pixelStorei(
        gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
        gl.NONE
      );
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

  function expandedViewportBounds() {
    const bounds = map.getBounds();
    const west = Number(bounds.getWest());
    const east = Number(bounds.getEast());
    const south = Number(bounds.getSouth());
    const north = Number(bounds.getNorth());
    const lonPad =
      Math.max(0, east - west) *
      VIEWPORT_OVERSCAN;
    const latPad =
      Math.max(0, north - south) *
      VIEWPORT_OVERSCAN;

    return {
      getWest: () => west - lonPad,
      getEast: () => east + lonPad,
      getSouth: () => south - latPad,
      getNorth: () => north + latPad
    };
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

    const x0 =
      mapboxgl.MercatorCoordinate.fromLngLat(
        [west, 0]
      ).x;
    const x1 =
      mapboxgl.MercatorCoordinate.fromLngLat(
        [east, 0]
      ).x;

    const positions = [];
    const uvs = [];

    function append(x, y, u, v) {
      positions.push(x, y);
      uvs.push(u, v);
    }

    for (
      let band = 0;
      band < LATITUDE_SEGMENTS;
      band += 1
    ) {
      const v0 =
        band / LATITUDE_SEGMENTS;
      const v1 =
        (band + 1) / LATITUDE_SEGMENTS;
      const lat0 =
        north - (north - south) * v0;
      const lat1 =
        north - (north - south) * v1;

      const y0 =
        mapboxgl.MercatorCoordinate.fromLngLat(
          [0, lat0]
        ).y;
      const y1 =
        mapboxgl.MercatorCoordinate.fromLngLat(
          [0, lat1]
        ).y;

      append(x0, y0, 0, v0);
      append(x0, y1, 0, v1);
      append(x1, y0, 1, v0);

      append(x1, y0, 1, v0);
      append(x0, y1, 0, v1);
      append(x1, y1, 1, v1);
    }

    return {
      positions:
        new Float32Array(positions),
      uvs:
        new Float32Array(uvs),
      vertexCount:
        LATITUDE_SEGMENTS * 6
    };
  }

  function firstSymbolLayerId() {
    return (
      map.getStyle()?.layers || []
    ).find(
      layer => layer.type === "symbol"
    )?.id;
  }

  function createOverlay() {
    return {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "2d",

      map: null,
      gl: null,
      program: null,
      nativeVisible: false,
      currentManifest: null,
      cache: new Map(),
      geometryCache: new Map(),
      queue: [],
      pending: new Set(),
      controllers: new Map(),
      activeFetches: 0,
      activeKeys: new Set(),
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

        const vs = compileShader(
          gl,
          gl.VERTEX_SHADER,
          vertexSource
        );
        const fs = compileShader(
          gl,
          gl.FRAGMENT_SHADER,
          fragmentSource
        );

        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        if (
          !gl.getProgramParameter(
            this.program,
            gl.LINK_STATUS
          )
        ) {
          throw new Error(
            gl.getProgramInfoLog(
              this.program
            ) ||
              "Native MRMS detail shader link failed"
          );
        }

        this.aPos =
          gl.getAttribLocation(
            this.program,
            "a_pos"
          );
        this.aUv =
          gl.getAttribLocation(
            this.program,
            "a_uv"
          );
        this.uMatrix =
          gl.getUniformLocation(
            this.program,
            "u_matrix"
          );
        this.uTexture =
          gl.getUniformLocation(
            this.program,
            "u_texture"
          );
        this.uOpacity =
          gl.getUniformLocation(
            this.program,
            "u_opacity"
          );
      },

      geometryKey(chunk) {
        return (
          String(chunk.id) +
          ":" +
          (chunk.bounds || [])
            .map(Number)
            .join(",")
        );
      },

      geometryForChunk(chunk) {
        const key =
          this.geometryKey(chunk);
        const existing =
          this.geometryCache.get(key);

        if (existing) return existing;
        if (!this.gl) return null;

        const gl = this.gl;
        const mesh = meshForChunk(chunk);

        const posBuffer =
          gl.createBuffer();
        gl.bindBuffer(
          gl.ARRAY_BUFFER,
          posBuffer
        );
        gl.bufferData(
          gl.ARRAY_BUFFER,
          mesh.positions,
          gl.STATIC_DRAW
        );

        const uvBuffer =
          gl.createBuffer();
        gl.bindBuffer(
          gl.ARRAY_BUFFER,
          uvBuffer
        );
        gl.bufferData(
          gl.ARRAY_BUFFER,
          mesh.uvs,
          gl.STATIC_DRAW
        );

        const geometry = {
          posBuffer,
          uvBuffer,
          vertexCount:
            mesh.vertexCount
        };

        this.geometryCache.set(
          key,
          geometry
        );
        return geometry;
      },

      key(chunk, manifest) {
        return (
          String(manifest.revision) +
          ":" +
          String(chunk.id)
        );
      },

      chunkUrl(chunk, manifest) {
        return new URL(
          String(chunk.image),
          new URL(".", manifest._url)
        ).href;
      },

      visibleChunks(manifest) {
        if (!manifest?.chunks?.length) {
          return [];
        }

        const bounds =
          expandedViewportBounds();

        return manifest.chunks.filter(
          chunk =>
            chunkIntersects(
              chunk,
              bounds
            )
        );
      },

      frameBytes(manifest) {
        return this.visibleChunks(
          manifest
        ).reduce(
          (total, chunk) =>
            total +
            Math.max(
              1,
              Number(chunk.width) || 1
            ) *
              Math.max(
                1,
                Number(chunk.height) || 1
              ) *
              4,
          0
        );
      },

      desiredRingDepth(
        startIndex =
          currentFrameIndex
      ) {
        const currentId =
          frameIdAt(startIndex);
        const manifest =
          frameManifestFromArchive(
            detailArchive,
            currentId
          );

        if (!manifest) return 2;

        const bytesPerFrame =
          Math.max(
            1,
            this.frameBytes(manifest)
          );

        // Reserve headroom for the current frame, camera movement and Mapbox.
        const futureBudget =
          MAX_GPU_TEXTURE_BYTES * 0.62;

        const memoryDepth =
          Math.max(
            2,
            Math.floor(
              futureBudget /
                bytesPerFrame
            )
          );

        const speed =
          currentPlaybackSpeed();
        const desired =
          speed >= 1.5
            ? 10
            : speed >= 1
              ? 7
              : 4;
        const deviceCap =
          MOBILE_DEVICE ? 7 : 12;

        return Math.max(
          2,
          Math.min(
            memoryDepth,
            desired,
            deviceCap,
            frames.length
          )
        );
      },

      lookaheadFrameIds(
        startIndex =
          currentFrameIndex
      ) {
        const depth =
          this.desiredRingDepth(
            startIndex
          );
        const ids = [];

        for (
          let offset = 1;
          offset < depth;
          offset += 1
        ) {
          const index =
            (
              startIndex + offset
            ) % frames.length;
          const frameId =
            frameIdAt(index);

          if (
            frameId &&
            nativeFrameExists(frameId) &&
            !ids.includes(frameId)
          ) {
            ids.push(frameId);
          }
        }

        return ids;
      },

      queueChunks(
        chunks,
        manifest,
        priority = false
      ) {
        const additions = [];
        const requestedKeys =
          new Set();

        for (const chunk of chunks) {
          const key =
            this.key(
              chunk,
              manifest
            );
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
          this.controllers.set(
            key,
            controller
          );

          additions.push({
            key,
            chunk,
            manifest,
            controller
          });
        }

        if (priority) {
          const promoted =
            this.queue.filter(
              item =>
                requestedKeys.has(
                  item.key
                )
            );

          this.queue =
            this.queue.filter(
              item =>
                !requestedKeys.has(
                  item.key
                )
            );

          this.queue.unshift(
            ...promoted,
            ...additions
          );
        } else {
          this.queue.push(
            ...additions
          );
        }

        this.pump();
      },

      requestFrame(
        frameId,
        priority = true
      ) {
        const manifest =
          frameManifestFromArchive(
            detailArchive,
            frameId
          );
        if (!manifest) return false;

        const chunks =
          this.visibleChunks(manifest);

        if (!chunks.length) {
          return false;
        }

        this.queueChunks(
          chunks,
          manifest,
          priority
        );

        return true;
      },

      prefetchFrameIds(frameIds) {
        if (
          !Array.isArray(frameIds)
        ) {
          return;
        }

        frameIds.forEach(
          (frameId, index) => {
            const manifest =
              frameManifestFromArchive(
                detailArchive,
                frameId
              );

            if (!manifest) return;

            this.queueChunks(
              this.visibleChunks(
                manifest
              ),
              manifest,
              index === 0
            );
          }
        );
      },

      frameReady(frameId) {
        const manifest =
          frameManifestFromArchive(
            detailArchive,
            frameId
          );
        if (!manifest) return false;

        const chunks =
          this.visibleChunks(
            manifest
          );

        if (!chunks.length) {
          return false;
        }

        return chunks.every(
          chunk =>
            this.cache.has(
              this.key(
                chunk,
                manifest
              )
            )
        );
      },

      async waitForFrame(
        frameId,
        timeoutMs
      ) {
        if (this.frameReady(frameId)) {
          return true;
        }

        this.requestFrame(
          frameId,
          true
        );

        const deadline =
          performance.now() +
          Math.max(
            0,
            Number(timeoutMs) || 0
          );

        while (
          performance.now() <
          deadline
        ) {
          if (
            this.frameReady(
              frameId
            )
          ) {
            return true;
          }

          await new Promise(
            resolve =>
              window.setTimeout(
                resolve,
                20
              )
          );
        }

        return this.frameReady(
          frameId
        );
      },

      async prime(
        startIndex
      ) {
        const normalized =
          normalizeIndex(
            startIndex
          );
        const startId =
          frameIdAt(normalized);

        if (!nativeFrameExists(startId)) {
          return 0;
        }

        const ids = [
          startId,
          ...this.lookaheadFrameIds(
            normalized
          )
        ];

        this.prefetchFrameIds(ids);

        const required =
          Math.min(
            MOBILE_DEVICE ? 3 : 4,
            ids.length
          );
        const deadline =
          performance.now() +
          (MOBILE_DEVICE
            ? 4500
            : 3500);

        while (
          performance.now() <
          deadline
        ) {
          let readyCount = 0;

          for (const frameId of ids) {
            if (
              !this.frameReady(
                frameId
              )
            ) {
              break;
            }
            readyCount += 1;
          }

          if (
            readyCount >= required
          ) {
            return readyCount;
          }

          await new Promise(
            resolve =>
              window.setTimeout(
                resolve,
                20
              )
          );
        }

        let readyCount = 0;
        for (const frameId of ids) {
          if (
            !this.frameReady(
              frameId
            )
          ) {
            break;
          }
          readyCount += 1;
        }

        return readyCount;
      },

      activate(frameId) {
        const manifest =
          frameManifestFromArchive(
            detailArchive,
            frameId
          );
        if (!manifest) return false;

        const visible =
          this.visibleChunks(
            manifest
          );

        if (
          !visible.length ||
          !visible.every(
            chunk =>
              this.cache.has(
                this.key(
                  chunk,
                  manifest
                )
              )
          )
        ) {
          return false;
        }

        this.currentManifest =
          manifest;
        this.wanted = new Map(
          visible.map(
            chunk => [
              this.key(
                chunk,
                manifest
              ),
              chunk
            ]
          )
        );

        this.drawSet =
          visible.map(
            chunk => ({
              key:
                this.key(
                  chunk,
                  manifest
                ),
              chunk
            })
          );

        const now =
          performance.now();

        for (
          const item of
            this.drawSet
        ) {
          const cached =
            this.cache.get(
              item.key
            );
          if (cached) {
            cached.lastUsed = now;
          }
        }

        this.nativeVisible = true;
        this.evict();
        this.map?.triggerRepaint();

        return true;
      },

      updateCurrentViewport() {
        if (
          !this.nativeVisible ||
          !this.currentManifest
        ) {
          return;
        }

        const currentId =
          frameIdAt();

        if (
          String(
            this.currentManifest
              .revision
          ) !== String(currentId)
        ) {
          return;
        }

        const visible =
          this.visibleChunks(
            this.currentManifest
          );

        this.wanted =
          new Map(
            visible.map(
              chunk => [
                this.key(
                  chunk,
                  this.currentManifest
                ),
                chunk
              ]
            )
          );

        this.queueChunks(
          visible,
          this.currentManifest,
          true
        );

        // Geographic expansion for the SAME observation may refine
        // progressively. Observation-to-observation swaps remain atomic.
        const readyVisible =
          visible
            .filter(
              chunk =>
                this.cache.has(
                  this.key(
                    chunk,
                    this.currentManifest
                  )
                )
            )
            .map(
              chunk => ({
                key:
                  this.key(
                    chunk,
                    this.currentManifest
                  ),
                chunk
              })
            );

        if (readyVisible.length) {
          this.drawSet =
            readyVisible;
        }

        this.evict();
        this.map?.triggerRepaint();
      },

      fetchConcurrency() {
        const chunkPixels =
          Number(
            this.currentManifest
              ?.chunkPixels
          ) ||
          Number(
            detailArchive
              ?.chunkPixels
          ) ||
          1024;

        if (
          chunkPixels <= 1024 &&
          currentPlaybackSpeed() >= 1.5
        ) {
          return FAST_FETCHES;
        }

        return MAX_FETCHES;
      },

      async pump() {
        while (
          this.activeFetches <
            this.fetchConcurrency() &&
          this.queue.length
        ) {
          const item =
            this.queue.shift();

          if (
            this.cache.has(
              item.key
            )
          ) {
            this.pending.delete(
              item.key
            );
            this.controllers.delete(
              item.key
            );
            continue;
          }

          if (
            item.controller
              ?.signal
              ?.aborted
          ) {
            this.pending.delete(
              item.key
            );
            this.controllers.delete(
              item.key
            );
            continue;
          }

          this.activeFetches += 1;
          this.activeKeys.add(
            item.key
          );

          this.fetchChunk(
            item
          ).finally(() => {
            this.activeKeys.delete(
              item.key
            );
            this.activeFetches -= 1;
            this.pump();
          });
        }
      },

      async fetchChunk(item) {
        try {
          const bitmap =
            await bitmapFromUrl(
              this.chunkUrl(
                item.chunk,
                item.manifest
              ),
              item.controller
                ?.signal
            );

          if (!this.gl) return;

          const texture =
            createTexture(
              this.gl,
              bitmap
            );

          if (bitmap.close) {
            bitmap.close();
          }

          const geometry =
            this.geometryForChunk(
              item.chunk
            );

          if (!geometry) {
            this.gl.deleteTexture(
              texture
            );
            return;
          }

          this.cache.set(
            item.key,
            {
              texture,
              chunk:
                item.chunk,
              geometry,
              byteSize:
                Math.max(
                  1,
                  Number(
                    item.chunk.width
                  ) || 1
                ) *
                Math.max(
                  1,
                  Number(
                    item.chunk.height
                  ) || 1
                ) *
                4,
              lastUsed:
                performance.now()
            }
          );
        } catch (error) {
          if (
            error?.name !==
            "AbortError"
          ) {
            console.warn(
              "Native MRMS detail chunk " +
                item.key +
                " failed",
              error
            );
          }
        } finally {
          this.pending.delete(
            item.key
          );
          this.controllers.delete(
            item.key
          );

          if (
            detailMode &&
            !this.nativeVisible
          ) {
            const currentId =
              frameIdAt();

            if (
              nativeFrameExists(
                currentId
              ) &&
              this.frameReady(
                currentId
              )
            ) {
              this.activate(
                currentId
              );
              syncVisualOwnership();
            }
          } else {
            this.updateCurrentViewport();
          }

          this.evict();
          this.map?.triggerRepaint();
        }
      },

      protectedKeys() {
        const keys =
          new Set([
            ...this.wanted.keys(),
            ...this.drawSet.map(
              item => item.key
            )
          ]);

        if (
          !detailMode ||
          !detailArchive ||
          !frames.length
        ) {
          return keys;
        }

        const futureBudget =
          MAX_GPU_TEXTURE_BYTES *
          0.62;
        let projected = 0;

        for (
          const frameId of
            this.lookaheadFrameIds(
              currentFrameIndex
            )
        ) {
          const manifest =
            frameManifestFromArchive(
              detailArchive,
              frameId
            );

          if (!manifest) continue;

          const chunks =
            this.visibleChunks(
              manifest
            );
          const bytes =
            chunks.reduce(
              (total, chunk) =>
                total +
                Math.max(
                  1,
                  Number(
                    chunk.width
                  ) || 1
                ) *
                Math.max(
                  1,
                  Number(
                    chunk.height
                  ) || 1
                ) *
                4,
              0
            );

          if (
            projected &&
            projected + bytes >
              futureBudget
          ) {
            break;
          }

          projected += bytes;

          for (
            const chunk of chunks
          ) {
            keys.add(
              this.key(
                chunk,
                manifest
              )
            );
          }
        }

        return keys;
      },

      evict() {
        if (!this.gl) return;

        let totalBytes =
          [...this.cache.values()]
            .reduce(
              (total, value) =>
                total +
                Math.max(
                  0,
                  Number(
                    value.byteSize
                  ) || 0
                ),
              0
            );

        if (
          this.cache.size <=
            MAX_GPU_CHUNKS &&
          totalBytes <=
            MAX_GPU_TEXTURE_BYTES
        ) {
          return;
        }

        const protectedKeys =
          this.protectedKeys();

        const removable =
          [...this.cache.entries()]
            .filter(
              ([key]) =>
                !protectedKeys.has(
                  key
                )
            )
            .sort(
              (a, b) =>
                a[1].lastUsed -
                b[1].lastUsed
            );

        while (
          (
            this.cache.size >
              MAX_GPU_CHUNKS ||
            totalBytes >
              MAX_GPU_TEXTURE_BYTES
          ) &&
          removable.length
        ) {
          const [key, value] =
            removable.shift();

          this.gl.deleteTexture(
            value.texture
          );

          totalBytes -=
            Math.max(
              0,
              Number(
                value.byteSize
              ) || 0
            );

          this.cache.delete(key);
        }
      },

      drawChunk(
        gl,
        matrix,
        item
      ) {
        const cached =
          this.cache.get(
            item.key
          );

        if (
          !cached?.texture ||
          !cached?.geometry
        ) {
          return;
        }

        cached.lastUsed =
          performance.now();

        const geometry =
          cached.geometry;

        gl.useProgram(
          this.program
        );
        gl.uniformMatrix4fv(
          this.uMatrix,
          false,
          matrix
        );
        gl.uniform1i(
          this.uTexture,
          0
        );
        gl.uniform1f(
          this.uOpacity,
          Number(
            opacityInput?.value ??
              1
          )
        );

        gl.bindBuffer(
          gl.ARRAY_BUFFER,
          geometry.posBuffer
        );
        gl.enableVertexAttribArray(
          this.aPos
        );
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
        gl.enableVertexAttribArray(
          this.aUv
        );
        gl.vertexAttribPointer(
          this.aUv,
          2,
          gl.FLOAT,
          false,
          0,
          0
        );

        gl.activeTexture(
          gl.TEXTURE0
        );
        gl.bindTexture(
          gl.TEXTURE_2D,
          cached.texture
        );

        gl.drawArrays(
          gl.TRIANGLES,
          0,
          geometry.vertexCount
        );
      },

      render(gl, matrix) {
        syncVisualOwnership();

        if (
          !this.nativeVisible ||
          !radarVisible ||
          !this.drawSet.length
        ) {
          return;
        }

        gl.disable(
          gl.DEPTH_TEST
        );
        gl.enable(gl.BLEND);
        gl.blendEquation(
          gl.FUNC_ADD
        );
        gl.blendFunc(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA
        );

        for (
          const item of
            this.drawSet
        ) {
          this.drawChunk(
            gl,
            matrix,
            item
          );
        }
      },

      clearTextures() {
        if (this.gl) {
          for (
            const value of
              this.cache.values()
          ) {
            if (value.texture) {
              this.gl.deleteTexture(
                value.texture
              );
            }
          }
        }

        this.cache.clear();
      },

      clearGeometry() {
        if (this.gl) {
          for (
            const geometry of
              this.geometryCache.values()
          ) {
            if (
              geometry.posBuffer
            ) {
              this.gl.deleteBuffer(
                geometry.posBuffer
              );
            }
            if (
              geometry.uvBuffer
            ) {
              this.gl.deleteBuffer(
                geometry.uvBuffer
              );
            }
          }
        }

        this.geometryCache.clear();
      },

      onRemove(mapRef, gl) {
        this.clearTextures();
        this.clearGeometry();

        if (this.program) {
          gl.deleteProgram(
            this.program
          );
        }

        this.gl = null;
      }
    };
  }

  function syncVisualOwnership() {
    if (!radarLayer) return;

    const baseVisible =
      Boolean(
        radarVisible &&
        !overlay?.nativeVisible
      );

    radarLayer.setVisible(
      baseVisible
    );
  }

  function currentZoomWantsDetail() {
    const zoom =
      Number(map?.getZoom?.());

    if (!Number.isFinite(zoom)) {
      return false;
    }

    if (detailMode) {
      return zoom >=
        EXIT_DETAIL_ZOOM;
    }

    return zoom >=
      ENTER_DETAIL_ZOOM;
  }

  function prefetchUpcomingDetail() {
    if (
      !detailMode ||
      !detailArchive ||
      !frames.length
    ) {
      return;
    }

    overlay?.prefetchFrameIds(
      overlay.lookaheadFrameIds(
        currentFrameIndex
      )
    );
  }

  async function enterDetailMode() {
    if (
      detailMode ||
      !overlay
    ) {
      return;
    }

    detailMode = true;
    leavingDetail = false;

    const currentId =
      frameIdAt();

    if (
      !nativeFrameExists(
        currentId
      )
    ) {
      syncVisualOwnership();
      return;
    }

    overlay.requestFrame(
      currentId,
      true
    );

    if (
      overlay.frameReady(
        currentId
      )
    ) {
      overlay.activate(
        currentId
      );
      syncVisualOwnership();
    }

    prefetchUpcomingDetail();
  }

  async function syncBaseToTimeline() {
    if (
      baseSyncBusy ||
      !overlay
    ) {
      return false;
    }

    if (
      baseTextureFrameId ===
      frameIdAt()
    ) {
      overlay.nativeVisible =
        false;
      leavingDetail = false;
      syncVisualOwnership();
      overlay.map?.triggerRepaint();
      return true;
    }

    baseSyncBusy = true;

    try {
      const result =
        await originalShowFrame(
          currentFrameIndex,
          { quiet: true }
        );

      if (result) {
        baseTextureFrameId =
          frameIdAt();
        overlay.nativeVisible =
          false;
        leavingDetail = false;
        syncVisualOwnership();
        overlay.map?.triggerRepaint();
      }

      return result;
    } finally {
      baseSyncBusy = false;
    }
  }

  async function exitDetailMode() {
    if (
      !detailMode ||
      !overlay
    ) {
      return;
    }

    detailMode = false;
    leavingDetail =
      overlay.nativeVisible;

    // Keep the last complete native observation visible while the overview
    // texture catches up to the same timeline observation.
    if (leavingDetail) {
      await syncBaseToTimeline();
    } else {
      syncVisualOwnership();
    }
  }

  function refreshMode() {
    if (!overlay) return;

    const wantsDetail =
      currentZoomWantsDetail();

    if (
      wantsDetail &&
      !detailMode
    ) {
      enterDetailMode()
        .catch(error =>
          console.warn(
            "Native detail enter failed",
            error
          )
        );
      return;
    }

    if (
      !wantsDetail &&
      detailMode
    ) {
      exitDetailMode()
        .catch(error =>
          console.warn(
            "Native detail exit failed",
            error
          )
        );
      return;
    }

    if (detailMode) {
      overlay.updateCurrentViewport();
      prefetchUpcomingDetail();
    }
  }

  function scheduleViewportRefresh() {
    if (viewportTimer) return;

    const elapsed =
      performance.now() -
      lastViewportSyncAt;

    const delay =
      Math.max(
        0,
        VIEWPORT_SYNC_MS -
          elapsed
      );

    viewportTimer =
      window.setTimeout(
        () => {
          viewportTimer = null;
          lastViewportSyncAt =
            performance.now();
          refreshMode();
        },
        delay
      );
  }

  let originalShowFrame = null;
  let originalPrimePlaybackBuffer = null;

  async function install(manifest) {
    if (
      installed ||
      !manifest ||
      !ready()
    ) {
      return false;
    }

    installed = true;
    detailArchive = manifest;
    overlay = createOverlay();

    const beforeId =
      firstSymbolLayerId();

    if (beforeId) {
      map.addLayer(
        overlay,
        beforeId
      );
    } else {
      map.addLayer(overlay);
    }

    baseTextureFrameId =
      frameIdAt();

    originalShowFrame =
      showFrame;
    originalPrimePlaybackBuffer =
      primePlaybackBuffer;

    // Playback ownership stays in the base radar. The base playbackLoop()
    // remains the ONLY animation clock. This wrapper only decides which
    // already-published texture representation satisfies the requested frame.
    showFrame =
      async function (
        index,
        options = {}
      ) {
        const requested =
          normalizeIndex(index);

        if (
          detailMode &&
          detailArchive &&
          frames.length
        ) {
          let nativeIndex =
            requested;
          let nativeId =
            frameIdAt(
              nativeIndex
            );

          if (
            !nativeFrameExists(
              nativeId
            )
          ) {
            if (isPlaying) {
              nativeIndex =
                nextNativeIndex(
                  requested
                );
              if (
                nativeIndex >= 0
              ) {
                nativeId =
                  frameIdAt(
                    nativeIndex
                  );
              }
            }
          }

          if (
            nativeIndex >= 0 &&
            nativeFrameExists(
              nativeId
            )
          ) {
            overlay.requestFrame(
              nativeId,
              true
            );

            const readyNow =
              overlay.frameReady(
                nativeId
              );

            const ready =
              readyNow ||
              (
                !isPlaying &&
                await overlay.waitForFrame(
                  nativeId,
                  MOBILE_DEVICE
                    ? 2600
                    : 1800
                )
              );

            if (ready) {
              currentFrameIndex =
                nativeIndex;

              if (
                overlay.activate(
                  nativeId
                )
              ) {
                updateFrameUi();
                syncVisualOwnership();
                prefetchUpcomingDetail();
                return true;
              }
            }

            // Hold the last complete native observation if the requested
            // detail frame is still loading. Never expose a base-frame fallback
            // while detail LOD owns the timeline.
            return false;
          }

          // A paired publisher should make this unreachable. During migration
          // or a transient manifest skew, keep the current complete frame rather
          // than letting the timestamp advance onto a different renderer.
          return false;
        }

        const result =
          await originalShowFrame(
            index,
            options
          );

        if (result) {
          baseTextureFrameId =
            frameIdAt();

          if (leavingDetail) {
            overlay.nativeVisible =
              false;
            leavingDetail =
              false;
          }
        }

        syncVisualOwnership();
        return result;
      };

    // Keep base startPlayback()/stopPlayback()/playbackLoop() untouched.
    // Only replace the startup BUFFER source while detail LOD is active.
    primePlaybackBuffer =
      async function (
        startIndex,
        ...args
      ) {
        if (
          detailMode &&
          overlay &&
          nativeFrameExists(
            frameIdAt(
              normalizeIndex(
                startIndex
              )
            )
          )
        ) {
          return await overlay.prime(
            startIndex
          );
        }

        return await originalPrimePlaybackBuffer(
          startIndex,
          ...args
        );
      };

    map.on(
      "move",
      scheduleViewportRefresh
    );

    map.on(
      "moveend",
      () => {
        if (viewportTimer) {
          window.clearTimeout(
            viewportTimer
          );
          viewportTimer = null;
        }

        lastViewportSyncAt =
          performance.now();
        refreshMode();

        if (
          !detailMode &&
          leavingDetail
        ) {
          syncBaseToTimeline()
            .catch(() => {});
        }
      }
    );

    opacityInput?.addEventListener(
      "input",
      () =>
        overlay?.map
          ?.triggerRepaint()
    );

    pollTimer =
      window.setInterval(
        async () => {
          try {
            const next =
              await fetchManifest();

            if (!next) return;

            detailArchive = next;

            if (detailMode) {
              const currentId =
                frameIdAt();

              if (
                nativeFrameExists(
                  currentId
                )
              ) {
                overlay.requestFrame(
                  currentId,
                  true
                );
              }

              prefetchUpcomingDetail();
            }
          } catch (error) {
            console.warn(
              "Native MRMS detail manifest refresh failed",
              error
            );
          }
        },
        POLL_MS
      );

    window.addEventListener(
      "beforeunload",
      () => {
        if (pollTimer) {
          window.clearInterval(
            pollTimer
          );
        }

        if (retryTimer) {
          window.clearTimeout(
            retryTimer
          );
        }

        if (viewportTimer) {
          window.clearTimeout(
            viewportTimer
          );
        }
      },
      { once: true }
    );

    if (
      map.getZoom() >=
      ENTER_DETAIL_ZOOM
    ) {
      await enterDetailMode();
    } else {
      syncVisualOwnership();
    }

    console.info(
      "MRMS detail LOD v2: one playback clock, " +
        String(
          detailArchive?.frames
            ?.length || 1
        ) +
        " paired native frame(s)"
    );

    return true;
  }

  async function tryInstall() {
    if (installed) return;

    const elapsed =
      Date.now() -
      STARTED_AT;

    if (!ready()) {
      retryTimer =
        window.setTimeout(
          tryInstall,
          elapsed <
            INSTALL_TIMEOUT_MS
            ? 100
            : POLL_MS
        );
      return;
    }

    try {
      const manifest =
        await fetchManifest();

      if (manifest) {
        await install(manifest);
        return;
      }

      radarLayer?.setVisible(
        radarVisible
      );
      console.info(
        "Native MRMS detail is not published yet; using overview radar"
      );
    } catch (error) {
      radarLayer?.setVisible(
        radarVisible
      );
      console.warn(
        "Native MRMS detail unavailable",
        error
      );
    }

    retryTimer =
      window.setTimeout(
        tryInstall,
        POLL_MS
      );
  }

  tryInstall();
})();
