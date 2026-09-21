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

  function nativeOnlyActive() {
    return !MOBILE && Boolean(nativeLayer?.enabled);
  }

  function isOverviewKey(key) {
    return String(key || "").startsWith("overview:");
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeOnlyV21OverviewPatched) {
      layer.__zwxNativeOnlyV21OverviewPatched = true;
      overviewLayer = layer;

      // Capture the real eviction function before the later overview-bandwidth
      // shim wraps it. At native zoom we can genuinely drop low-res GPU data.
      const baseEvictExcept = layer.evictExcept;
      purgeOverviewTextures = () => {
        if (!overviewLayer || typeof baseEvictExcept !== "function") return;
        baseEvictExcept.call(overviewLayer, new Set());
        overviewLayer.map?.triggerRepaint?.();
      };

      const originalHasTexture = layer.hasTexture;
      if (typeof originalHasTexture === "function") {
        layer.hasTexture = function(key) {
          // The core player still uses overview keys as its timeline clock.
          // In desktop native mode those keys become virtual clock entries so
          // no overview frame download is required.
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
          // At deep/native zoom there is now exactly one visible radar quality.
          // The overview object remains only as a zero-data playback clock.
          if (nativeOnlyActive()) return;
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxNativeOnlyV21NativePatched) {
      layer.__zwxNativeOnlyV21NativePatched = true;
      nativeLayer = layer;

      const originalSetEnabled = layer.setEnabled;
      if (typeof originalSetEnabled === "function") {
        layer.setEnabled = function(enabled) {
          const output = originalSetEnabled.call(this, enabled);

          if (enabled && !MOBILE) {
            // Reclaim any overview textures left from the low-zoom view. The
            // v20 Play gate will preload the complete native viewport loop.
            purgeOverviewTextures();
          }

          return output;
        };
      }
    }

    return result;
  };

  window.__ZWX_MRALA_NATIVE_ONLY_STATE__ = () => ({
    mobile: MOBILE,
    active: nativeOnlyActive(),
    nativeEnabled: Boolean(nativeLayer?.enabled),
    overviewTextures: Number(overviewLayer?.textures?.size || 0),
    nativeTextures: Number(nativeLayer?.textures?.size || 0),
    fullNative: window.__ZWX_MRALA_FULL_NATIVE_STATE__?.() || null
  });

  console.info(
    MOBILE
      ? "MRALA v21: mobile unchanged"
      : "MRALA v21: desktop deep zoom is native-only • overview downloads/rendering disabled while native is active"
  );
})();
