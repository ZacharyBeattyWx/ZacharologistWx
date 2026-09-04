(() => {
  "use strict";

  // Rollback shim for browsers that still have the short-lived individual-site
  // NEXRAD loader cached. The site-radar experiment is intentionally disabled;
  // MRMS overview/native detail remain the only frontend radar renderers.
  const LAYER_ID = "nexrad-site-detail-layer";
  const SOURCE_ID = "nexrad-site-detail-source";
  const NATIVE_DETAIL_LAYER_ID = "mrms-native-detail-overlay";

  window.__ZWX_NEXRAD_SITE_DETAIL_DISABLED__ = true;

  function cleanup() {
    try {
      if (typeof map === "undefined" || !map) return;

      if (map.getLayer?.(LAYER_ID)) {
        map.removeLayer(LAYER_ID);
      }
      if (map.getSource?.(SOURCE_ID)) {
        map.removeSource(SOURCE_ID);
      }

      if (map.getLayer?.(NATIVE_DETAIL_LAYER_ID)) {
        map.setLayoutProperty(NATIVE_DETAIL_LAYER_ID, "visibility", "visible");
      }

      try {
        if (typeof radarLayer !== "undefined" && radarLayer) {
          radarLayer.setVisible(Boolean(radarVisible));
        }
      } catch (_) {}

      map.triggerRepaint?.();
    } catch (_) {}
  }

  cleanup();
  window.setTimeout(cleanup, 0);
  window.setTimeout(cleanup, 250);
  window.setTimeout(cleanup, 1000);

  console.info("NEXRAD site detail experiment disabled; MRMS renderer restored");
})();
