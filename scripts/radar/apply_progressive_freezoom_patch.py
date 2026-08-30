from pathlib import Path
import re

p = Path("scripts/radar/nexrad-freezoom-webgl.js")
s = p.read_text(encoding="utf-8")

s = s.replace("const DETAIL_SWITCH_ZOOM = 6.85;", "const DETAIL_SWITCH_ZOOM = 6.25;")

s, n = re.subn(
    r"  function sourceTileZoom\(mapZoom\) \{.*?\n  \}",
    """  function sourceTileZoom(mapZoom) {
    // Progressive LOD: get useful detail quickly, then refine only after the
    // next complete viewport is ready. The currently displayed LOD stays put
    // during the camera zoom, so there is no tile-pyramid rebuild under the user.
    if (mapZoom >= 8.75) return 9;  // ~120 m rendered pixels
    if (mapZoom >= 7.45) return 8;  // ~240 m rendered pixels
    return 7;                       // ~480 m rendered pixels
  }""",
    s, count=1, flags=re.S
)
if n != 1:
    raise SystemExit(f"sourceTileZoom replacement failed: {n}")

s = s.replace(
    "      wanted: new Map(),\n      fetchQueue: [],",
    "      wanted: new Map(),\n      displayed: new Map(),\n      displayedZoom: null,\n      fetchQueue: [],",
    1,
)

visible_pattern = re.compile(
    r"""      visibleTiles\(\) \{\n.*?        return tiles;\n      \},""",
    re.S,
)
visible_replacement = """      visibleTilesAt(z) {
        if (!this.serverOnline || this.map.getZoom() < DETAIL_SWITCH_ZOOM) return [];
        const n = 2 ** z;
        const bounds = this.map.getBounds();
        const west = Math.max(-179.999, bounds.getWest());
        const east = Math.min(179.999, bounds.getEast());
        const north = Math.min(85.0, bounds.getNorth());
        const south = Math.max(-85.0, bounds.getSouth());

        let x0 = lngToTileX(west, z) - 1;
        let x1 = lngToTileX(east, z) + 1;
        let y0 = latToTileY(north, z) - 1;
        let y1 = latToTileY(south, z) + 1;
        x0 = Math.max(0, x0); x1 = Math.min(n - 1, x1);
        y0 = Math.max(0, y0); y1 = Math.min(n - 1, y1);

        const tiles = [];
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const [tw, ts, te, tn] = tileBounds(z, x, y);
            if (te <= nationalWest || tw >= nationalEast || tn <= nationalSouth || ts >= nationalNorth) continue;
            tiles.push({ z, x, y, key: this.tileKey(z, x, y) });
          }
        }
        return tiles;
      },

      visibleTiles() {
        return this.visibleTilesAt(sourceTileZoom(this.map.getZoom()));
      },"""
s, n = visible_pattern.subn(visible_replacement, s, count=1)
if n != 1:
    raise SystemExit(f"visibleTiles replacement failed: {n}")

s = s.replace(
    ".filter(([key]) => !this.wanted.has(key))",
    ".filter(([key]) => !this.wanted.has(key) && !this.displayed.has(key))",
    1,
)

render_pattern = re.compile(
    r"""      render\(gl, matrix\) \{\n.*?\n      \},\n\n      onRemove\(mapRef, gl\) \{""",
    re.S,
)
render_replacement = """      render(gl, matrix) {
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        const zoom = this.map.getZoom();
        if (!this.serverOnline || zoom < DETAIL_SWITCH_ZOOM) {
          this.drawNationalFull(gl, matrix);
          this.updateUi();
          return;
        }

        // Freeze the radar source set while the camera is actively zooming.
        // The already-loaded texture simply scales with Mapbox's geographic matrix.
        if (!this.map.isZooming()) {
          const current = this.visibleTiles();
          const currentKey = current.map(t => t.key).join("|");
          const wantedKey = [...this.wanted.keys()].join("|");
          if (currentKey !== wantedKey) this.updateWantedTiles();
        }

        const desired = [...this.wanted.values()];
        const desiredReady = desired.length > 0 &&
          desired.every(tile => this.tileCache.has(tile.key));

        if (desiredReady) {
          // Atomic promotion: the new LOD becomes visible only when the entire
          // viewport is ready. No checkerboard of parent/child/fallback tiles.
          this.displayed = new Map(desired.map(tile => [tile.key, tile]));
          this.displayedZoom = desired[0].z;
        }

        let drawTiles = null;
        if (desiredReady) {
          drawTiles = desired;
        } else if (this.displayedZoom !== null) {
          // Keep the previous complete LOD on screen while the finer LOD loads.
          // This is the key to retaining sharpness during z7 -> z8 -> z9 refinement.
          const fallback = this.visibleTilesAt(this.displayedZoom);
          const fallbackReady = fallback.length > 0 &&
            fallback.every(tile => this.tileCache.has(tile.key));
          if (fallbackReady) drawTiles = fallback;
        }

        if (!drawTiles) {
          // A pan can expose uncached territory. Until one complete detail set is
          // ready for the new viewport, use one continuous national surface rather
          // than mixing coarse and fine rectangles.
          this.drawNationalFull(gl, matrix);
          this.updateUi();
          return;
        }

        for (const tile of drawTiles) this.drawTileCell(gl, matrix, tile);
        this.updateUi();
      },

      onRemove(mapRef, gl) {"""
s, n = render_pattern.subn(render_replacement, s, count=1)
if n != 1:
    raise SystemExit(f"render replacement failed: {n}")

s = s.replace(
    'modeTitle.textContent = "Loading Python-colored radar detail…";\n          modeDetail.textContent = `${loaded}/${total} visible detail tiles ready`;',
    'modeTitle.textContent = this.displayedZoom !== null ? "Refining radar detail…" : "Loading Python-colored radar detail…";\n          modeDetail.textContent = `${loaded}/${total} z${sourceTileZoom(z)} tiles ready${this.displayedZoom !== null ? ` • showing z${this.displayedZoom} meanwhile` : ""}`;',
    1,
)
s = s.replace(
    'modeDetail.textContent = "Python owns every displayed radar color; Mapbox only positions the texture.";',
    'modeDetail.textContent = `Python-colored z${this.displayedZoom ?? sourceTileZoom(z)} detail • Mapbox only positions the texture.`;',
    1,
)

p.write_text(s, encoding="utf-8")

p = Path("scripts/radar/serve_nexrad_detail_tiles.py")
s = p.read_text(encoding="utf-8")
s = s.replace("DEFAULT_MAX_SITES_PER_TILE = 24", "DEFAULT_MAX_SITES_PER_TILE = 12")
p.write_text(s, encoding="utf-8")
