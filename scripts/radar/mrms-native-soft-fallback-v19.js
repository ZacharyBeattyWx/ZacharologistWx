(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_SOFT_FALLBACK_V19__) return;
  window.__ZWX_MRALA_NATIVE_SOFT_FALLBACK_V19__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxNativeSoftFallbackV19Installed) return;
  mapPrototype.__zwxNativeSoftFallbackV19Installed = true;

  let overviewLayer = null;
  let nativeLayer = null;

  function isPlaying() {
    return /Pause/i.test(
      String(document.getElementById("playPause")?.textContent || "")
    );
  }

  function frameIdFromOverviewKey(key) {
    const text = String(key || "");
    return text.startsWith("overview:")
      ? text.slice("overview:".length)
      : "";
  }

  function nativeMatchesOverview(layer) {
    if (!overviewLayer || !layer?.enabled) return true;

    const ids = [...new Set((layer.visibleIds || []).map(String))];
    if (!ids.length) return false;

    const fromId = frameIdFromOverviewKey(overviewLayer.activeKey);
    const nextId = frameIdFromOverviewKey(overviewLayer.nextKey) || fromId;
    if (!fromId) return true;

    const blending =
      Boolean(overviewLayer.nextKey) &&
      Number(overviewLayer.mixAmount || 0) > 0;

    if (!layer.hasFrame?.(fromId, ids)) return false;
    if (blending && !layer.hasFrame?.(nextId, ids)) return false;

    if (String(layer.fromFrame || "") !== fromId) return false;
    if (blending && String(layer.toFrame || "") !== nextId) return false;

    return true;
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID) {
      overviewLayer = layer;
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxNativeSoftFallbackV19Patched) {
      layer.__zwxNativeSoftFallbackV19Patched = true;
      nativeLayer = layer;

      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function(...renderArgs) {
          // The overview timeline is the clock. If native detail is not fully
          // resident and synchronized to that exact timestamp/blend, do not
          // draw a stale native frame over it. The already-loaded overview
          // remains visible while the native rolling queue catches up.
          if (isPlaying() && !nativeMatchesOverview(this)) {
            return;
          }

          return originalRender.apply(this, renderArgs);
        };
      }
    }

    return result;
  };

  window.__ZWX_MRALA_SOFT_FALLBACK_STATE__ = () => ({
    playing: isPlaying(),
    overviewFrame: frameIdFromOverviewKey(overviewLayer?.activeKey),
    overviewNextFrame: frameIdFromOverviewKey(overviewLayer?.nextKey),
    nativeFromFrame: String(nativeLayer?.fromFrame || ""),
    nativeToFrame: String(nativeLayer?.toFrame || ""),
    nativeReadyForOverview: nativeLayer
      ? nativeMatchesOverview(nativeLayer)
      : false
  });

  console.info(
    "MRALA v19: overview stays hot as the playback clock • native detail overlays only when timestamp-ready • no hard native starvation pause"
  );
})();
