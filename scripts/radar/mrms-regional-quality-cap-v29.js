(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const params = new URLSearchParams(window.location.search);
  if (String(params.get("viewer") || "").toLowerCase() !== "regional") return;
  if (window.__ZWX_MRALA_REGIONAL_QUALITY_CAP_V29__) return;
  window.__ZWX_MRALA_REGIONAL_QUALITY_CAP_V29__ = true;

  // v25 enters the f2 (~4K-class / 3500x1750) pyramid at z4.90 and does not
  // enter full-native f1 until z6.00. Keep Regional entirely inside that band.
  const REGIONAL_START_ZOOM = 5.20;
  const REGIONAL_MAX_ZOOM = 5.85;
  const TARGET_LAYER_IDS = new Set([
    "mrms-native-numeric-dbz-layer",
    "mrms-native-numeric-viewport-chunks"
  ]);

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxRegionalQualityCapV29Installed) return;
  mapPrototype.__zwxRegionalQualityCapV29Installed = true;

  const previousAddLayer = mapPrototype.addLayer;
  let applied = false;

  function applyRegionalPolicy(map) {
    if (applied || !map) return;
    applied = true;

    try {
      map.setMaxZoom?.(REGIONAL_MAX_ZOOM);

      const zoom = Number(map.getZoom?.());
      if (!Number.isFinite(zoom) || zoom < 4.90) {
        map.jumpTo?.({ zoom: REGIONAL_START_ZOOM });
      } else if (zoom > REGIONAL_MAX_ZOOM) {
        map.jumpTo?.({ zoom: REGIONAL_MAX_ZOOM });
      }

      console.info(
        "MRALA v29 regional mode: f2 quality band locked • start z" +
          REGIONAL_START_ZOOM.toFixed(2) +
          " • max z" + REGIONAL_MAX_ZOOM.toFixed(2) +
          " • full-native f1 blocked"
      );
    } catch (error) {
      console.warn("MRALA v29 regional quality cap failed", error);
    }
  }

  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (TARGET_LAYER_IDS.has(String(layer?.id || ""))) {
      applyRegionalPolicy(this);
    }
    return result;
  };
})();
