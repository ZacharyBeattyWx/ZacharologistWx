(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxPlaybackStabilityV12Installed) return;
  mapPrototype.__zwxPlaybackStabilityV12Installed = true;

  let nativeLayer = null;
  let lastHoldLog = 0;

  const normalizeIds = ids => [...new Set((ids || []).map(String))].sort();
  const textureKey = (frameId, chunkId) => `${frameId}:${chunkId}`;
  const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");

  function manifest() {
    return window.__ZWX_MRALA_RUNTIME_MANIFEST__ || null;
  }

  function timelineFrames() {
    const frames = Array.isArray(manifest()?.frames) ? manifest().frames : [];
    return frames
      .filter(frame => frame?.id && Number.isFinite(frameMs(frame)))
      .sort((a, b) => frameMs(a) - frameMs(b));
  }

  function visibleIds(layer = nativeLayer) {
    return normalizeIds(layer?.__zwxRequestedVisibleIds || []);
  }

  function nextTimelineFrame() {
    const frames = timelineFrames();
    if (!frames.length) return null;
    const slider = document.getElementById("frameSlider");
    const current = Math.max(0, Math.min(frames.length - 1, Math.round(Number(slider?.value || 0))));
    return frames[(current + 1) % frames.length] || null;
  }

  function nextNativeFrameReady(layer = nativeLayer) {
    if (!layer?.enabled || !layer.__zwxHdLocked) return true;
    if (layer.map?.isMoving?.() || layer.map?.isZooming?.() || layer.map?.isRotating?.()) return true;

    const ids = visibleIds(layer);
    if (!ids.length) return true;
    const next = nextTimelineFrame();
    if (!next?.id || !next?.nativeChunksReady) return false;

    return ids.every(id => layer.textures?.has(textureKey(next.id, id)));
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeOnlyV12Patched) {
      layer.__zwxNativeOnlyV12Patched = true;
      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function (...renderArgs) {
          if (nativeLayer?.enabled && nativeLayer.__zwxHdLocked) return;
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxPlaybackStabilityV12Patched) {
      layer.__zwxPlaybackStabilityV12Patched = true;
      nativeLayer = layer;

      // v13 is now the only forward-runway owner. Clear any stale v12 pin set
      // left by an older cached session/build so it cannot compete for VRAM.
      layer.__zwxV12RunwayKeys = new Set();

      console.info(
        "MRALA archive player v12.1: native-only after HD lock • emergency next-frame guard retained • duplicate v12 runway disabled in favor of v13 timeline runway"
      );
    }

    return result;
  };

  // Install after mapbox-token.js finishes its playback-clock wrapper so this
  // remains the outermost safety gate. v13 owns all proactive runway loading.
  setTimeout(() => {
    if (window.__ZWX_MRALA_V12_RAF_GUARD__) return;
    window.__ZWX_MRALA_V12_RAF_GUARD__ = true;
    const previousRaf = window.requestAnimationFrame.bind(window);

    function isPlaybackTick(callback) {
      if (typeof callback !== "function") return false;
      try { return /\bplaybackTick\b/.test(Function.prototype.toString.call(callback)); }
      catch { return false; }
    }

    window.requestAnimationFrame = function (callback) {
      if (!isPlaybackTick(callback)) return previousRaf(callback);

      const layer = nativeLayer || window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
      if (!layer?.enabled || !layer.__zwxHdLocked || nextNativeFrameReady(layer)) {
        return previousRaf(callback);
      }

      const now = performance.now();
      if (now - lastHoldLog > 1200) {
        lastHoldLog = now;
        console.info(
          "MRALA v12.1 playback guard HOLD: next native frame not GPU-ready; timeline held while v13 runway catches up"
        );
      }

      return previousRaf(() => {
        window.requestAnimationFrame(callback);
      });
    };
  }, 0);
})();
