(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_PYRAMID_DYNAMIC_GEOMETRY_V26__) return;
  window.__ZWX_MRALA_PYRAMID_DYNAMIC_GEOMETRY_V26__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxPyramidDynamicGeometryV26Installed) return;
  mapPrototype.__zwxPyramidDynamicGeometryV26Installed = true;

  function ensureGeometry(layer, chunk) {
    const id = String(chunk?.id || "");
    if (!id || !layer?.gl || !layer?.geometries || layer.geometries.has(id)) return;

    const bounds = (chunk?.bounds || []).map(Number);
    if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value))) return;

    const [west, south, east, north] = bounds;
    const nw = mapboxgl.MercatorCoordinate.fromLngLat([west, north]);
    const ne = mapboxgl.MercatorCoordinate.fromLngLat([east, north]);
    const sw = mapboxgl.MercatorCoordinate.fromLngLat([west, south]);
    const se = mapboxgl.MercatorCoordinate.fromLngLat([east, south]);

    const gl = layer.gl;
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        nw.x, nw.y,
        sw.x, sw.y,
        ne.x, ne.y,
        ne.x, ne.y,
        sw.x, sw.y,
        se.x, se.y
      ]),
      gl.STATIC_DRAW
    );

    layer.geometries.set(id, {
      pos,
      north,
      south,
      northMerc: mapboxgl.MercatorCoordinate.fromLngLat([0, north]).y,
      southMerc: mapboxgl.MercatorCoordinate.fromLngLat([0, south]).y
    });
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === NATIVE_ID && !layer.__zwxPyramidDynamicGeometryV26Patched) {
      layer.__zwxPyramidDynamicGeometryV26Patched = true;

      const originalAddTexture = layer.addTexture;
      if (typeof originalAddTexture === "function") {
        layer.addTexture = function(frameId, chunk, data) {
          ensureGeometry(this, chunk);
          return originalAddTexture.call(this, frameId, chunk, data);
        };
      }

      const originalSetVisible = layer.setVisible;
      if (typeof originalSetVisible === "function") {
        layer.setVisible = function(ids) {
          const requested = [...new Set((ids || []).map(String))];
          const output = originalSetVisible.call(this, requested);

          // The core renderer only knew the original f1/native chunk IDs when
          // it was created. Pyramid chunk geometry is registered as textures
          // arrive, so expose any registered f4/f2/f1 IDs to that same renderer.
          this.visibleIds = requested.filter(id => this.geometries?.has(id));
          this.map?.triggerRepaint?.();
          return output;
        };
      }
    }

    return result;
  };

  console.info(
    "MRALA v26: dynamic pyramid geometry enabled • f4/f2/f1 use the same native renderer"
  );
})();
