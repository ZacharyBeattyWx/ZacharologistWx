window.MAPBOX_PUBLIC_TOKEN = "pk.eyJ1IjoiemFjaGFyeWJlYXR0eXd4IiwiYSI6ImNtcGRpOHFxOTBja2Iyc29nOXBtNDJkOTgifQ.A5PX2kdbDFzGYOoHmmnrKg";

(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const DBZ_MIN = -32;
  const DBZ_STEP = 0.5;
  const LEGEND_MIN_DBZ = -30;
  const LEGEND_MAX_DBZ = 60;
  const NATIVE_ENTER_ZOOM = 5.50;
  const OVERVIEW_REENTER_ZOOM = 5.20;
  const MOBILE = window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Playback-cadence experiment: give each real MRMS observation enough time
  // to be presented as a smooth animation instead of racing through 1-3 screen
  // refreshes per observation. The radar data and archive cadence are untouched.
  const PLAYBACK_CADENCE = new Map([
    ["0.5×", "340"],
    ["1×", "170"],
    ["1.5×", "115"],
    ["2×", "85"]
  ]);

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

  function applyPlaybackCadence() {
    const select = document.getElementById("speedSelect");
    if (!select) return false;

    const selectedLabel = String(
      select.selectedOptions?.[0]?.textContent || "1×"
    ).trim();

    for (const option of select.options) {
      const label = String(option.textContent || "").trim();
      const nextValue = PLAYBACK_CADENCE.get(label);
      if (nextValue) option.value = nextValue;
    }

    const selected = [...select.options].find(
      option => String(option.textContent || "").trim() === selectedLabel
    );
    if (selected) select.value = selected.value;

    console.info(
      "MRALA playback cadence: 0.5x 340ms • 1x 170ms • 1.5x 115ms • 2x 85ms"
    );
    return true;
  }

  // The core renderer currently asks for blend updates at ~30 Hz. On desktop,
  // wrap its GPU blend method in a presentation loop driven directly by rAF.
  // Source observations still advance on the core clock; only the in-between
  // visual states are presented at display refresh cadence (typically 60 Hz).
  function patchDisplayRateBlend(layer, blendMethod, activateMethods = []) {
    if (MOBILE || !layer || layer.__zwx60HzBlendPatched) return;
    const originalBlend = layer[blendMethod];
    if (typeof originalBlend !== "function") return;

    layer.__zwx60HzBlendPatched = true;

    let pair = "";
    let generation = 0;
    let raf = 0;
    let startTime = 0;
    let fromArg = null;
    let toArg = null;

    const intervalMs = () => Math.max(
      40,
      Number(document.getElementById("speedSelect")?.value || 170)
    );

    function cancelPresentation() {
      generation += 1;
      pair = "";
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    layer[blendMethod] = function (from, to, amount) {
      const numericAmount = Math.max(0, Math.min(1, Number(amount) || 0));
      const nextPair = String(from) + "\u0000" + String(to);

      if (nextPair !== pair) {
        cancelPresentation();
        pair = nextPair;
        fromArg = from;
        toArg = to;
        startTime = performance.now() - numericAmount * intervalMs();

        // Preserve the renderer's readiness semantics before taking ownership
        // of the rest of the transition.
        const ready = originalBlend.call(this, fromArg, toArg, numericAmount);
        if (ready === false) {
          pair = "";
          return false;
        }

        const localGeneration = generation;
        const instance = this;

        const present = now => {
          if (localGeneration !== generation || !pair) return;

          const progress = Math.max(
            0,
            Math.min(1, (now - startTime) / intervalMs())
          );

          const ok = originalBlend.call(instance, fromArg, toArg, progress);
          if (ok === false || progress >= 1) {
            raf = 0;
            return;
          }

          raf = requestAnimationFrame(present);
        };

        raf = requestAnimationFrame(present);
        return true;
      }

      // The rAF presentation loop already owns this source-frame pair. Ignore
      // the core's lower-frequency duplicate blend update.
      return true;
    };

    for (const methodName of activateMethods) {
      const originalActivate = layer[methodName];
      if (typeof originalActivate !== "function") continue;

      layer[methodName] = function (...args) {
        cancelPresentation();
        return originalActivate.apply(this, args);
      };
    }

    console.info(
      "MRALA desktop presentation: display-refresh GPU interpolation enabled for " +
        layer.id
    );
  }

  window.addEventListener("DOMContentLoaded", () => {
    redrawLegendWithTrueDbzScale();
    applyPlaybackCadence();
    window.setTimeout(redrawLegendWithTrueDbzScale, 120);
  }, { once: true });

  console.info("MRALA palette: negative dBZ colors preserved from -32 dBZ");

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

        return new Response(JSON.stringify(manifest), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      } catch (error) {
        console.warn("MRALA production LOD manifest patch failed", error);
        return response;
      }
    };

    console.info(
      "MRALA production LOD: native enter z" +
        NATIVE_ENTER_ZOOM.toFixed(2) +
        ", overview reenter z" +
        OVERVIEW_REENTER_ZOOM.toFixed(2)
    );
  }

  if (
    !window.__ZWX_MRALA_ATOMIC_VIEWPORT_PATCH__ &&
    window.mapboxgl?.Map?.prototype?.addLayer
  ) {
    window.__ZWX_MRALA_ATOMIC_VIEWPORT_PATCH__ = true;
    const mapPrototype = window.mapboxgl.Map.prototype;
    const originalAddLayer = mapPrototype.addLayer;

    mapPrototype.addLayer = function (layer, ...args) {
      if (layer?.id === "mrms-native-numeric-dbz-layer") {
        patchDisplayRateBlend(layer, "setBlend", ["activate"]);
      }

      if (layer?.id === "mrms-native-numeric-viewport-chunks") {
        patchDisplayRateBlend(layer, "setBlendFrames", ["activateFrame"]);

        if (!layer.__zwxAtomicViewportPatched) {
          layer.__zwxAtomicViewportPatched = true;
          layer.__zwxPendingVisibleIds = null;

          const originalSetVisible = layer.setVisible;
          const originalAddTexture = layer.addTexture;
          const originalSetEnabled = layer.setEnabled;

          layer.setVisible = function (ids) {
            const nextIds = [...new Set((ids || []).map(String))];

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
      }

      return originalAddLayer.call(this, layer, ...args);
    };
  }
})();

(() => {
  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const src = "scripts/radar/mrms-native-loop-prewarm.js?v=20260908d";

  if (document.readyState === "loading") {
    document.write('<script src="' + src + '"></script>');
    return;
  }

  const script = document.createElement("script");
  script.src = src;
  script.async = false;
  document.head.appendChild(script);
})();