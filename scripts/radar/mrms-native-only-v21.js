(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_ONLY_V21__) return;
  window.__ZWX_MRALA_NATIVE_ONLY_V21__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxNativeOnlyV21Installed) return;
  mapPrototype.__zwxNativeOnlyV21Installed = true;

  let overviewLayer = null;
  let nativeLayer = null;
  let purgeOverviewTextures = () => {};
  let handoffReady = false;
  let zooming = false;
  let handoffTimer = 0;

  function nativeOnlyActive() {
    return !MOBILE && Boolean(nativeLayer?.enabled) && handoffReady;
  }

  function isOverviewKey(key) {
    return String(key || "").startsWith("overview:");
  }

  function visibleIds() {
    return [...new Set((nativeLayer?.visibleIds || []).map(String))];
  }

  function currentNativeReady() {
    if (!nativeLayer?.enabled) return false;
    const ids = visibleIds();
    const frameId = String(nativeLayer.fromFrame || nativeLayer.toFrame || "");
    return Boolean(
      ids.length &&
      frameId &&
      nativeLayer.hasFrame?.(frameId, ids)
    );
  }

  function clearHandoffTimer() {
    if (handoffTimer) window.clearTimeout(handoffTimer);
    handoffTimer = 0;
  }

  function scheduleHandoff(delay = 80) {
    if (MOBILE || !nativeLayer?.enabled || handoffReady) return;
    clearHandoffTimer();

    handoffTimer = window.setTimeout(() => {
      handoffTimer = 0;
      if (!nativeLayer?.enabled || handoffReady) return;

      // Do not change radar quality while the user is actively zooming.
      if (zooming || !currentNativeReady()) {
        scheduleHandoff(60);
        return;
      }

      // Give the ready native frame one paint opportunity before removing the
      // overview. The visible handoff therefore happens after zoom settles and
      // only when a complete native frame is already resident.
      window.requestAnimationFrame?.(() => {
        window.requestAnimationFrame?.(() => {
          if (!nativeLayer?.enabled || zooming || !currentNativeReady()) {
            scheduleHandoff(60);
            return;
          }

          handoffReady = true;
          purgeOverviewTextures();
          overviewLayer?.map?.triggerRepaint?.();
          nativeLayer?.map?.triggerRepaint?.();

          console.info(
            "MRALA v21 native-only handoff: native frame ready after zoom settle • overview released"
          );
        });
      });
    }, Math.max(0, delay));
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeOnlyV21OverviewPatched) {
      layer.__zwxNativeOnlyV21OverviewPatched = true;
      overviewLayer = layer;

      // Capture the real eviction function before the later overview-bandwidth
      // shim wraps it. Once the native handoff is complete we can genuinely
      // drop the low-resolution GPU data.
      const baseEvictExcept = layer.evictExcept;
      purgeOverviewTextures = () => {
        if (!overviewLayer || typeof baseEvictExcept !== "function") return;
        baseEvictExcept.call(overviewLayer, new Set());
        overviewLayer.map?.triggerRepaint?.();
      };

      const originalHasTexture = layer.hasTexture;
      if (typeof originalHasTexture === "function") {
        layer.hasTexture = function(key) {
          // After handoff the core player still uses overview keys as its
          // timeline clock, but they no longer require low-res downloads.
          if (nativeOnlyActive() && isOverviewKey(key)) return true;
          return originalHasTexture.call(this, key);
        };
      }

      const originalActivate = layer.activate;
      if (typeof originalActivate === "function") {
        layer.activate = function(key) {
          if (nativeOnlyActive() && isOverviewKey(key)) {
            this.activeKey = String(key);
            this.nextKey = "";
            this.mixAmount = 0;
            this.map?.triggerRepaint?.();
            return true;
          }
          return originalActivate.call(this, key);
        };
      }

      const originalSetBlend = layer.setBlend;
      if (typeof originalSetBlend === "function") {
        layer.setBlend = function(fromKey, toKey, amount) {
          if (
            nativeOnlyActive() &&
            isOverviewKey(fromKey) &&
            isOverviewKey(toKey)
          ) {
            this.activeKey = String(fromKey);
            this.nextKey = String(toKey);
            this.mixAmount = Math.max(0, Math.min(1, Number(amount) || 0));
            this.map?.triggerRepaint?.();
            return true;
          }
          return originalSetBlend.call(this, fromKey, toKey, amount);
        };
      }

      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function(...renderArgs) {
          // Keep overview visible while the zoom gesture is occurring and while
          // native prepares. Suppress it only after an atomic ready handoff.
          if (nativeOnlyActive()) return;
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxNativeOnlyV21NativePatched) {
      layer.__zwxNativeOnlyV21NativePatched = true;
      nativeLayer = layer;

      // Until handoffReady, prevent native from suddenly appearing on top of
      // the overview mid-gesture. The quality change occurs once, after zoomend,
      // with a complete frame already resident.
      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function(...renderArgs) {
          if (!MOBILE && this.enabled && !handoffReady) return;
          return originalRender.apply(this, renderArgs);
        };
      }

      const originalSetEnabled = layer.setEnabled;
      if (typeof originalSetEnabled === "function") {
        layer.setEnabled = function(enabled) {
          const output = originalSetEnabled.call(this, enabled);

          if (enabled && !MOBILE) {
            handoffReady = false;
            scheduleHandoff(40);
          } else if (!enabled) {
            handoffReady = false;
            clearHandoffTimer();
            overviewLayer?.map?.triggerRepaint?.();
          }

          return output;
        };
      }

      const originalActivateFrame = layer.activateFrame;
      if (typeof originalActivateFrame === "function") {
        layer.activateFrame = function(...activateArgs) {
          const output = originalActivateFrame.apply(this, activateArgs);
          if (output && this.enabled && !handoffReady) scheduleHandoff(20);
          return output;
        };
      }

      layer.map?.on?.("zoomstart", () => {
        zooming = true;
      });

      layer.map?.on?.("zoomend", () => {
        zooming = false;
        if (layer.enabled && !handoffReady) scheduleHandoff(40);
      });
    }

    return result;
  };

  window.__ZWX_MRALA_NATIVE_ONLY_STATE__ = () => ({
    mobile: MOBILE,
    active: nativeOnlyActive(),
    nativeEnabled: Boolean(nativeLayer?.enabled),
    handoffReady,
    zooming,
    currentNativeReady: currentNativeReady(),
    overviewTextures: Number(overviewLayer?.textures?.size || 0),
    nativeTextures: Number(nativeLayer?.textures?.size || 0),
    fullNative: window.__ZWX_MRALA_FULL_NATIVE_STATE__?.() || null,
    lodHandoff: window.__ZWX_MRALA_LOD_HANDOFF_STATE__?.() || null
  });

  console.info(
    MOBILE
      ? "MRALA v21: mobile unchanged"
      : "MRALA v21: native-only handoff waits for zoom settle + a complete native frame before releasing overview"
  );
})();