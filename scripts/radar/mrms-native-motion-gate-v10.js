(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  const LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxMotionGateV10Installed) return;
  mapPrototype.__zwxMotionGateV10Installed = true;

  const normalizeIds = ids => [...new Set((ids || []).map(String))].sort();
  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== LAYER_ID || layer.__zwxMotionGateV10Patched) return result;

    layer.__zwxMotionGateV10Patched = true;
    layer.__zwxMotionGatePendingIds = [];

    const innerSetVisible = layer.setVisible;
    const map = layer.map || this;
    let applyingSettledIds = false;

    const cameraMoving = () => Boolean(
      map?.isMoving?.() ||
      map?.isZooming?.() ||
      map?.isRotating?.()
    );

    layer.setVisible = function (ids) {
      const nextIds = normalizeIds(ids);

      if (
        this.enabled &&
        !applyingSettledIds &&
        cameraMoving()
      ) {
        // v9's move listener is already warming the current camera footprint.
        // Do not let its normal setVisible path start a competing native warm.
        this.__zwxMotionGatePendingIds = nextIds;
        return;
      }

      this.__zwxMotionGatePendingIds = [];
      return innerSetVisible.call(this, nextIds);
    };

    const applySettledIds = () => {
      const pending = normalizeIds(layer.__zwxMotionGatePendingIds || []);
      if (!pending.length || !layer.enabled) return;

      layer.__zwxMotionGatePendingIds = [];
      applyingSettledIds = true;
      try {
        innerSetVisible.call(layer, pending);
      } finally {
        applyingSettledIds = false;
      }
    };

    map?.on?.("moveend", applySettledIds);
    map?.on?.("zoomend", applySettledIds);

    console.info(
      "MRALA archive player v10 motion gate: normal native startup deferred during camera motion • motion-warmed startup applied on settle"
    );

    return result;
  };
})();
