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
  let lastUnavailableLog = 0;

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

  const X2_BUCKET_MS = 5 * 60 * 1000;

  function fiveMinuteX2Enabled() {
    return String(
      document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent || ""
    ).trim() === "2×";
  }

  function nextDisplayIndex(frames, current) {
    if (!frames.length) return -1;
    const index = Math.max(0, Math.min(frames.length - 1, Number(current) || 0));
    const sequential = (index + 1) % frames.length;
    if (!fiveMinuteX2Enabled() || index === frames.length - 1) return sequential;

    const currentMs = frameMs(frames[index]);
    if (!Number.isFinite(currentMs)) return sequential;
    const nextBucket = (Math.floor(currentMs / X2_BUCKET_MS) + 1) * X2_BUCKET_MS;

    for (let candidate = index + 1; candidate < frames.length; candidate += 1) {
      const candidateMs = frameMs(frames[candidate]);
      if (Number.isFinite(candidateMs) && candidateMs >= nextBucket) return candidate;
    }
    return frames.length - 1;
  }

  function nextTimelineFrame() {
    const frames = timelineFrames();
    if (!frames.length) return null;
    const slider = document.getElementById("frameSlider");
    const current = Math.max(0, Math.min(frames.length - 1, Math.round(Number(slider?.value || 0))));
    return frames[nextDisplayIndex(frames, current)] || null;
  }

  function nextNativeFrameState(layer = nativeLayer) {
    if (!layer?.enabled || !layer.__zwxHdLocked) {
      return { ready: true, reason: "inactive", missing: [] };
    }
    if (layer.map?.isMoving?.() || layer.map?.isZooming?.() || layer.map?.isRotating?.()) {
      return { ready: true, reason: "camera-moving", missing: [] };
    }

    const ids = visibleIds(layer);
    if (!ids.length) return { ready: true, reason: "no-visible-chunks", missing: [] };

    const next = nextTimelineFrame();
    if (!next?.id) return { ready: true, reason: "no-next-frame", missing: [] };

    // Do not stall the whole loop on an observation that simply has no native
    // chunks yet. Native-only presentation will carry the last complete sharp
    // frame across this short interval while playback advances to the next scan.
    if (!next.nativeChunksReady) {
      return {
        ready: true,
        reason: "native-unavailable",
        frame: next,
        missing: ids.slice()
      };
    }

    const missing = ids.filter(id => !layer.textures?.has(textureKey(next.id, id)));
    return {
      ready: missing.length === 0,
      reason: missing.length ? "texture-miss" : "ready",
      frame: next,
      missing
    };
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

      // v13.x is the only proactive forward-runway owner.
      layer.__zwxV12RunwayKeys = new Set();

      console.info(
        "MRALA archive player v12.3: native-only after HD lock • 2x guard follows 5-minute display targets • native-unavailable scans do not stall the loop"
      );
    }

    return result;
  };

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
      const state = nextNativeFrameState(layer);

      if (state.ready) {
        if (state.reason === "native-unavailable") {
          const now = performance.now();
          if (now - lastUnavailableLog > 2500) {
            lastUnavailableLog = now;
            console.info(
              "MRALA v12.3 guard PASS:",
              String(state.frame?.id || "unknown"),
              "has no native chunks yet; carrying the last sharp native frame across this interval"
            );
          }
        }
        return previousRaf(callback);
      }

      const now = performance.now();
      if (now - lastHoldLog > 900) {
        lastHoldLog = now;
        console.info(
          "MRALA v12.3 playback guard HOLD:",
          String(state.frame?.id || "unknown"),
          state.missing.length + "/" + visibleIds(layer).length + " visible native texture(s) missing",
          "• timeline held briefly while v13.2 hot runway catches up"
        );
      }

      return previousRaf(() => {
        window.requestAnimationFrame(callback);
      });
    };
  }, 0);
})();