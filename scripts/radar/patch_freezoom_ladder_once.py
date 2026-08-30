from pathlib import Path
import re

js_path = Path("scripts/radar/nexrad-freezoom-webgl.js")
s = js_path.read_text(encoding="utf-8")

s = s.replace("const MAX_GPU_TILES = 96;", "const MAX_GPU_TILES = 160;")
s = s.replace("const MAX_FETCHES = 6;", "const MAX_FETCHES = 8;")
s = s.replace(
    'if (!response.ok) throw new Error(`Radar image HTTP ${response.status}`);',
    'if (!response.ok) throw new Error(`Radar image HTTP ${response.status}: ${url}`);'
)

# Do not require a full extra ring of tiles before a viewport can promote.
s = s.replace("let x0 = lngToTileX(west, z) - 1;", "let x0 = lngToTileX(west, z);")
s = s.replace("let x1 = lngToTileX(east, z) + 1;", "let x1 = lngToTileX(east, z);")
s = s.replace("let y0 = latToTileY(north, z) - 1;", "let y0 = latToTileY(north, z);")
s = s.replace("let y1 = latToTileY(south, z) + 1;", "let y1 = latToTileY(south, z);")

# Force the renderer to earn a complete base LOD first, then climb one level at a time.
old = '''      updateWantedTiles() {
        const tiles = this.visibleTiles();
        this.wanted = new Map(tiles.map(tile => [tile.key, tile]));'''
new = '''      updateWantedTiles() {
        if (!this.serverOnline || this.map.getZoom() < DETAIL_SWITCH_ZOOM) {
          this.wanted = new Map();
          this.updateUi();
          return;
        }

        const desiredZoom = sourceTileZoom(this.map.getZoom());
        let loadZoom;
        if (this.displayedZoom === null) {
          // Always establish the quick base detail layer first. If the user zooms
          // rapidly to z8/z9, do not abandon z7 and leave the 1-km national image
          // enlarged on screen while dozens of finer tiles render.
          loadZoom = 7;
        } else if (desiredZoom > this.displayedZoom) {
          loadZoom = Math.min(desiredZoom, this.displayedZoom + 1);
        } else {
          loadZoom = desiredZoom;
        }

        const tiles = this.visibleTilesAt(loadZoom);
        this.wanted = new Map(tiles.map(tile => [tile.key, tile]));'''
if old not in s:
    raise SystemExit("updateWantedTiles anchor not found")
s = s.replace(old, new, 1)

# Replace the render-time target-grid comparison. moveend/zoomend already update
# the requested viewport; promotion itself will queue the next LOD.
old = '''        // Freeze the radar source set while the camera is actively zooming.
        // The already-loaded texture simply scales with Mapbox's geographic matrix.
        if (!this.map.isZooming()) {
          const current = this.visibleTiles();
          const currentKey = current.map(t => t.key).join("|");
          const wantedKey = [...this.wanted.keys()].join("|");
          if (currentKey !== wantedKey) this.updateWantedTiles();
        }

        const desired = [...this.wanted.values()];'''
new = '''        // Freeze the radar source set while the camera is actively zooming.
        // moveend/zoomend choose the next requested LOD; the current complete
        // texture set simply scales with Mapbox's geographic matrix meanwhile.
        if (!this.map.isZooming() && this.wanted.size === 0) {
          this.updateWantedTiles();
        }

        const desired = [...this.wanted.values()];'''
if old not in s:
    raise SystemExit("render comparison anchor not found")
s = s.replace(old, new, 1)

old = '''        if (desiredReady) {
          // Atomic promotion: the new LOD becomes visible only when the entire
          // viewport is ready. No checkerboard of parent/child/fallback tiles.
          this.displayed = new Map(desired.map(tile => [tile.key, tile]));
          this.displayedZoom = desired[0].z;
        }'''
new = '''        if (desiredReady) {
          // Atomic promotion: the new LOD becomes visible only when the entire
          // viewport is ready. No checkerboard of parent/child/fallback tiles.
          const promotedZoom = desired[0].z;
          const promotedKey = desired.map(tile => tile.key).join("|");
          const displayedKey = [...this.displayed.keys()].join("|");
          const changed = this.displayedZoom !== promotedZoom || promotedKey !== displayedKey;
          this.displayed = new Map(desired.map(tile => [tile.key, tile]));
          this.displayedZoom = promotedZoom;

          // If the camera already warrants a finer LOD, start it only after this
          // complete level is safely on screen (national -> z7 -> z8 -> z9).
          if (changed && sourceTileZoom(zoom) > promotedZoom) {
            setTimeout(() => this.updateWantedTiles(), 0);
          }
        }'''
if old not in s:
    raise SystemExit("promotion anchor not found")
s = s.replace(old, new, 1)

# UI should report the LOD actually being loaded, not the final camera target.
s = s.replace(
    'modeDetail.textContent = `${loaded}/${total} z${sourceTileZoom(z)} tiles ready${this.displayedZoom !== null ? ` • showing z${this.displayedZoom} meanwhile` : ""}`;',
    'const loadingZoom = tiles[0]?.z ?? sourceTileZoom(z);\n          modeDetail.textContent = `${loaded}/${total} z${loadingZoom} tiles ready${this.displayedZoom !== null ? ` • showing z${this.displayedZoom} meanwhile` : ""}`;'
)

js_path.write_text(s, encoding="utf-8")

py_path = Path("scripts/radar/serve_nexrad_detail_tiles.py")
p = py_path.read_text(encoding="utf-8")
p = p.replace("DEFAULT_MAX_SITES_PER_TILE = 12", "DEFAULT_MAX_SITES_PER_TILE = 10")
p = p.replace(
    '''                except ValueError as exc:\n                    self.send_error(404, str(exc))\n                    return''',
    '''                except ValueError as exc:\n                    print(f"404 TILE {path}: {exc}")\n                    self.send_error(404, str(exc))\n                    return'''
)
py_path.write_text(p, encoding="utf-8")

print("Patched sequential free-zoom LOD loading and tile diagnostics")
