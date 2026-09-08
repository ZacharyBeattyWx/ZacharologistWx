window.MAPBOX_PUBLIC_TOKEN = "pk.eyJ1IjoiemFjaGFyeWJlYXR0eXd4IiwiYSI6ImNtcGRpOHFxOTBja2Iyc29nOXBtNDJkOTgifQ.A5PX2kdbDFzGYOoHmmnrKg";

(() => {
  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  // Keep the numeric MRMS values untouched. The uint8 archive already stores
  // 1 = -32 dBZ through 255 = +95 dBZ in 0.5 dBZ increments. The old browser
  // LUT reused tile-display cleanup and made much of the negative range fully
  // transparent. Build the GPU palette directly from the shared production
  // reflectivity table instead so negative clear-air returns remain visible.
  const DBZ_MIN = -32;
  const DBZ_STEP = 0.5;
  const LEGEND_MIN_DBZ = -30;
  const LEGEND_MAX_DBZ = 60;

  const PALETTE_STOPS = [
    [-32,88,54,128,8],[-30,96,62,138,10],[-28,105,72,145,12],
    [-26,116,85,150,15],[-24,128,99,153,18],[-22,139,113,153,22],
    [-20,148,128,150,28],[-18,155,140,145,34],[-16,160,150,138,42],
    [-14,163,157,130,52],[-12,160,158,123,62],[-10,156,155,119,72],
    [-8,167,167,136,80],[-6,175,176,150,88],[-4,158,163,150,98],
    [-2,135,144,145,108],[0,115,128,142,120],[2,92,109,137,132],
    [4,73,93,133,144],[6,55,81,132,156],[8,63,97,141,168],
    [10,73,117,152,180],[15,76,165,142,205],[20,18,118,24,230],
    [25,203,222,1,245],[30,215,203,0,255],[35,227,129,3,255],
    [40,185,95,10,255],[45,192,37,20,255],[50,202,153,180,255],
    [55,196,74,138,255],[60,139,32,210,255],[65,86,20,162,255],
    [70,111,210,219,255],[75,74,132,154,255],[80,115,10,1,255],
    [85,235,190,255,255],[90,255,230,245,255],[95,255,255,255,255]
  ];

  function paletteColor(dbz) {
    const value = Math.max(
      PALETTE_STOPS[0][0],
      Math.min(PALETTE_STOPS[PALETTE_STOPS.length - 1][0], Number(dbz))
    );

    for (let index = 1; index < PALETTE_STOPS.length; index += 1) {
      const right = PALETTE_STOPS[index];
      if (value > right[0]) continue;

      const left = PALETTE_STOPS[index - 1];
      const span = right[0] - left[0];
      const mix = span > 0 ? (value - left[0]) / span : 0;

      return [1,2,3,4].map(channel =>
        Math.max(0, Math.min(255, Math.round(
          left[channel] + (right[channel] - left[channel]) * mix
        )))
      );
    }

    return PALETTE_STOPS[PALETTE_STOPS.length - 1].slice(1);
  }

  const correctedPaletteLut = new Uint8Array(256 * 4);
  correctedPaletteLut.set([0,0,0,0], 0);

  for (let code = 1; code < 256; code += 1) {
    const dbz = DBZ_MIN + (code - 1) * DBZ_STEP;
    correctedPaletteLut.set(paletteColor(dbz), code * 4);
  }

  function looksLikeOldMralaPalette(pixels) {
    return (
      pixels instanceof Uint8Array &&
      pixels.length === 1024 &&
      pixels[0] === 0 && pixels[1] === 0 && pixels[2] === 0 && pixels[3] === 0 &&
      pixels[4] === 88 && pixels[5] === 54 && pixels[6] === 128
    );
  }

  function patchWebGlPalettePrototype(Prototype) {
    if (!Prototype || Prototype.__zwxNegativeDbzPalettePatched) return;

    const originalTexImage2D = Prototype.texImage2D;
    if (typeof originalTexImage2D !== "function") return;

    Object.defineProperty(Prototype, "__zwxNegativeDbzPalettePatched", {
      value: true,
      configurable: true
    });

    Prototype.texImage2D = function (...args) {
      // Radar palette upload signature:
      // target, level, internalFormat, 256, 1, border, RGBA, UNSIGNED_BYTE, data
      if (
        args.length >= 9 &&
        Number(args[3]) === 256 &&
        Number(args[4]) === 1 &&
        args[6] === this.RGBA &&
        args[7] === this.UNSIGNED_BYTE &&
        looksLikeOldMralaPalette(args[8])
      ) {
        args[8] = correctedPaletteLut;
      }

      return originalTexImage2D.apply(this, args);
    };
  }

  patchWebGlPalettePrototype(window.WebGLRenderingContext?.prototype);
  patchWebGlPalettePrototype(window.WebGL2RenderingContext?.prototype);

  function dbzToPaletteCode(dbz) {
    return Math.max(
      1,
      Math.min(
        255,
        Math.round((Number(dbz) - DBZ_MIN) / DBZ_STEP) + 1
      )
    );
  }

  function redrawLegendWithTrueDbzScale() {
    const canvas = document.getElementById("legendBar");
    if (!canvas) return false;

    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    const width = canvas.width || 256;
    const image = ctx.createImageData(width, 1);

    for (let x = 0; x < width; x += 1) {
      const fraction = width > 1 ? x / (width - 1) : 0;
      const dbz = LEGEND_MIN_DBZ +
        (LEGEND_MAX_DBZ - LEGEND_MIN_DBZ) * fraction;
      const code = dbzToPaletteCode(dbz);
      const source = code * 4;
      const target = x * 4;

      image.data[target] = correctedPaletteLut[source];
      image.data[target + 1] = correctedPaletteLut[source + 1];
      image.data[target + 2] = correctedPaletteLut[source + 2];
      image.data[target + 3] = 255;
    }

    ctx.putImageData(image, 0, 0);
    return true;
  }

  // The page's inline radar script draws its old legend after this file loads.
  // Redraw after DOM construction and once more shortly afterward so the visible
  // legend always matches the actual -30..60 dBZ positions in the corrected LUT.
  window.addEventListener("DOMContentLoaded", () => {
    redrawLegendWithTrueDbzScale();
    window.setTimeout(redrawLegendWithTrueDbzScale, 120);
  }, { once: true });

  console.info("MRALA palette: negative dBZ colors preserved from -32 dBZ");

  // The 3500px overview still contains enough source detail for the regional
  // view. Switching to native MRALA at z4.9 caused the radar to visibly change
  // several seconds after the user stopped zooming, even though the camera had
  // not moved. Keep the stable overview through regional zoom, then use native
  // chunks only once their extra source resolution is actually useful.
  const NATIVE_ENTER_ZOOM = 6.15;
  const OVERVIEW_REENTER_ZOOM = 5.85;

  if (!window.__ZWX_MRALA_PRODUCTION_LOD_FETCH_PATCH__) {
    window.__ZWX_MRALA_PRODUCTION_LOD_FETCH_PATCH__ = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async function (input, init) {
      const response = await originalFetch(input, init);
      const url = String(
        typeof input === "string"
          ? input
          : input?.url || ""
      );

      if (
        !response.ok ||
        !/\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i.test(url)
      ) {
        return response;
      }

      try {
        const manifest = await response.clone().json();
        const overview = manifest?.lod?.overview;
        const native = manifest?.lod?.native;

        if (!overview || !native) return response;

        overview.recommendedMaxZoom = NATIVE_ENTER_ZOOM;
        native.recommendedMinZoom = OVERVIEW_REENTER_ZOOM;

        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        headers.delete("etag");

        return new Response(
          JSON.stringify(manifest),
          {
            status: response.status,
            statusText: response.statusText,
            headers
          }
        );
      } catch (error) {
        console.warn("MRALA production LOD manifest patch failed", error);
        return response;
      }
    };

    console.info(
      "MRALA production LOD: overview through z" +
        NATIVE_ENTER_ZOOM.toFixed(2) +
        ", native exit z" +
        OVERVIEW_REENTER_ZOOM.toFixed(2)
    );
  }

  // The native viewport layer used to replace its visible chunk list as soon as
  // the camera moved. New chunks then appeared individually as their textures
  // arrived, which made a stationary radar field seem to change in blocks.
  // Stage the requested viewport and expose it only after the currently drawn
  // native observation is complete for the whole new viewport.
  if (
    !window.__ZWX_MRALA_ATOMIC_VIEWPORT_PATCH__ &&
    window.mapboxgl?.Map?.prototype?.addLayer
  ) {
    window.__ZWX_MRALA_ATOMIC_VIEWPORT_PATCH__ = true;

    const mapPrototype = window.mapboxgl.Map.prototype;
    const originalAddLayer = mapPrototype.addLayer;

    mapPrototype.addLayer = function (layer, ...args) {
      if (
        layer?.id === "mrms-native-numeric-viewport-chunks" &&
        !layer.__zwxAtomicViewportPatched
      ) {
        layer.__zwxAtomicViewportPatched = true;
        layer.__zwxPendingVisibleIds = null;

        const originalSetVisible = layer.setVisible;
        const originalAddTexture = layer.addTexture;
        const originalSetEnabled = layer.setEnabled;

        layer.setVisible = function (ids) {
          const nextIds = [
            ...new Set(
              (ids || [])
                .map(String)
            )
          ];

          if (
            this.enabled &&
            this.fromFrame &&
            nextIds.length &&
            !this.hasFrame(this.fromFrame, nextIds)
          ) {
            this.__zwxPendingVisibleIds = nextIds;
            return;
          }

          this.__zwxPendingVisibleIds = null;
          return originalSetVisible.call(this, nextIds);
        };

        layer.addTexture = function (...textureArgs) {
          const result = originalAddTexture.apply(this, textureArgs);
          const pending = this.__zwxPendingVisibleIds;

          if (
            pending?.length &&
            this.fromFrame &&
            this.hasFrame(this.fromFrame, pending)
          ) {
            this.__zwxPendingVisibleIds = null;
            originalSetVisible.call(this, pending);
          }

          return result;
        };

        layer.setEnabled = function (enabled) {
          if (!enabled) {
            this.__zwxPendingVisibleIds = null;
          }
          return originalSetEnabled.call(this, enabled);
        };

        console.info("MRALA native viewport: atomic camera handoff enabled");
      }

      return originalAddLayer.call(this, layer, ...args);
    };
  }
})();

(() => {
  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-canvas-test\.html$/i.test(path)) return;

  // X2 playback is owned by the core radar scheduler and native-detail buffer.
  // Do not load the legacy timelapse/stride overrides here; they created
  // competing playback clocks.

  const performanceScript = document.createElement("script");
  performanceScript.src = "scripts/radar/mrms-playback-performance.js?v=20260904a";
  performanceScript.async = false;
  document.head.appendChild(performanceScript);

  const SCRUB_RETRY_MS = 50;
  const SCRUB_INSTALL_TIMEOUT_MS = 20000;
  const scrubInstallStartedAt = Date.now();

  function scrubReady() {
    try {
      return (
        typeof frameSlider !== "undefined" &&
        frameSlider &&
        typeof frames !== "undefined" &&
        Array.isArray(frames) &&
        typeof isPlaying !== "undefined" &&
        typeof showFrame === "function" &&
        typeof stopPlayback === "function" &&
        typeof updateFrameUi === "function"
      );
    } catch (_) {
      return false;
    }
  }

  function installFrameScrubber() {
    if (window.__ZWX_MRMS_FRAME_SCRUBBER__) return true;
    if (!scrubReady()) return false;

    window.__ZWX_MRMS_FRAME_SCRUBBER__ = true;

    const slider = frameSlider;
    const originalUpdateFrameUi = updateFrameUi;
    let scrubbing = false;
    let pointerActive = false;
    let scrubTarget = Number(slider.value) || 0;
    let pumpRunning = false;
    let finishRunning = false;
    let idleCommitTimer = null;

    function clampIndex(value) {
      if (!Array.isArray(frames) || !frames.length) return 0;
      const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
      return Math.max(0, Math.min(frames.length - 1, Math.round(numeric)));
    }

    function delay(ms) {
      return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function holdThumbAtTarget() {
      if (!scrubbing) return;
      slider.value = String(clampIndex(scrubTarget));
    }

    // Frame activation updates the normal time/readout UI, but while a user is
    // physically scrubbing the timeline it must not yank the thumb backward to
    // whichever async texture happened to finish first.
    updateFrameUi = function (...args) {
      const result = originalUpdateFrameUi(...args);
      holdThumbAtTarget();
      return result;
    };

    function beginScrub() {
      if (scrubbing) return;
      stopPlayback();
      scrubbing = true;
      scrubTarget = clampIndex(slider.value);
      holdThumbAtTarget();
    }

    async function fastRequest(index) {
      // Native detail normally waits for a paused/manual frame to become fully
      // resident. During a drag that wait is exactly what makes the thumb feel
      // stuck. Borrow playback semantics only for this one request so the LOD
      // queues the desired frame and returns immediately if it is not ready.
      const wasPlaying = Boolean(isPlaying);
      if (!wasPlaying) isPlaying = true;
      try {
        return await showFrame(index, {
          quiet: true,
          scrubPreview: true
        });
      } finally {
        if (!wasPlaying) isPlaying = false;
      }
    }

    async function pumpScrub() {
      if (pumpRunning || !scrubbing) return;
      pumpRunning = true;

      try {
        while (scrubbing) {
          const requested = clampIndex(scrubTarget);
          const shown = await fastRequest(requested);
          holdThumbAtTarget();

          if (!scrubbing) break;
          if (requested !== clampIndex(scrubTarget)) continue;

          // If the requested native frame is still arriving, poll lightly.
          // This coalesces hundreds of slider input events into one latest-frame
          // request instead of building a long async backlog.
          if (!shown) {
            await delay(36);
            continue;
          }

          break;
        }
      } catch (error) {
        console.warn("MRMS scrub preview failed", error);
      } finally {
        pumpRunning = false;
        if (scrubbing && clampIndex(scrubTarget) !== Number(currentFrameIndex)) {
          window.setTimeout(pumpScrub, 0);
        }
      }
    }

    async function finishScrub() {
      if ((!scrubbing && !pointerActive) || finishRunning) return;
      finishRunning = true;
      pointerActive = false;
      scrubbing = false;

      if (idleCommitTimer) {
        window.clearTimeout(idleCommitTimer);
        idleCommitTimer = null;
      }

      const finalIndex = clampIndex(scrubTarget);

      try {
        // Let the current fast preview request unwind before asking for the
        // exact full-quality native observation.
        for (let attempt = 0; pumpRunning && attempt < 30; attempt += 1) {
          await delay(12);
        }

        let shown = false;
        for (let attempt = 0; attempt < 3 && !shown; attempt += 1) {
          shown = await showFrame(finalIndex, {
            quiet: true,
            scrubCommit: true
          });
          if (!shown) await delay(45);
        }

        originalUpdateFrameUi();
      } catch (error) {
        console.warn("MRMS scrub commit failed", error);
      } finally {
        finishRunning = false;
      }
    }

    function scheduleKeyboardCommit() {
      if (pointerActive) return;
      if (idleCommitTimer) window.clearTimeout(idleCommitTimer);
      idleCommitTimer = window.setTimeout(() => {
        idleCommitTimer = null;
        finishScrub();
      }, 140);
    }

    slider.addEventListener(
      "pointerdown",
      () => {
        pointerActive = true;
        beginScrub();
      },
      true
    );

    // Capture-phase ownership intentionally runs before the original core
    // `input -> await showFrame()` handler. That older handler remains as the
    // no-JS-patch fallback, but it must not run during the optimized scrub path.
    slider.addEventListener(
      "input",
      event => {
        beginScrub();
        scrubTarget = clampIndex(slider.value);
        event.stopImmediatePropagation();
        holdThumbAtTarget();
        pumpScrub();
        scheduleKeyboardCommit();
      },
      true
    );

    slider.addEventListener(
      "change",
      event => {
        event.stopImmediatePropagation();
        scrubTarget = clampIndex(slider.value);
        finishScrub();
      },
      true
    );

    window.addEventListener("pointerup", finishScrub, true);
    window.addEventListener("pointercancel", finishScrub, true);
    slider.addEventListener("blur", finishScrub, true);

    console.info("MRMS frame scrubber: latest-frame coalescing enabled");
    return true;
  }

  function patchScrubberWhenReady() {
    if (installFrameScrubber()) return;
    if (Date.now() - scrubInstallStartedAt >= SCRUB_INSTALL_TIMEOUT_MS) {
      console.warn("MRMS frame scrubber did not find the radar controls");
      return;
    }
    window.setTimeout(patchScrubberWhenReady, SCRUB_RETRY_MS);
  }

  patchScrubberWhenReady();

  const params = new URLSearchParams(window.location.search);
  if (params.get("home") === "1") {
    const homeScript = document.createElement("script");
    homeScript.src = "scripts/radar/mrms-homepage-mode.js?v=20260902c";
    homeScript.async = true;
    document.head.appendChild(homeScript);

    const mobileScript = document.createElement("script");
    mobileScript.src = "scripts/radar/mrms-homepage-mobile.js?v=20260830d";
    mobileScript.async = true;
    document.head.appendChild(mobileScript);
  }
})();
