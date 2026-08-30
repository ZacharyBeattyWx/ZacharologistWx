from pathlib import Path

js_path = Path('scripts/radar/nexrad-freezoom-webgl.js')
js = js_path.read_text(encoding='utf-8')

js = js.replace('const DETAIL_SWITCH_ZOOM = 6.25;', 'const DETAIL_SWITCH_ZOOM = 2.0;')

old_lod = '''  function sourceTileZoom(mapZoom) {
    // 1024px radar tiles: z7 already lands near the native ~240 m N0B sampling
    // across much of the CONUS, which recreates the earlier 4K-style detail with
    // far fewer requests than z8/512. z8 is a closer-zoom refinement only.
    if (mapZoom >= 8.60) return 8;  // ~120 m rendered pixels (oversampled refinement)
    return 7;                       // ~240 m rendered pixels (native-detail base)
  }'''
new_lod = '''  function sourceTileZoom(mapZoom) {
    // One site-derived 1024px radar pyramid at every camera scale. The coarse
    // national GINI is never the visible LOD; it exists only inside Python as a
    // gap filler where no individual NEXRAD site has a valid sample.
    if (mapZoom >= 8.60) return 8;  // ~120 m rendered pixels
    if (mapZoom >= 7.10) return 7;  // ~240 m rendered pixels
    if (mapZoom >= 5.55) return 6;  // ~480 m rendered pixels
    return 5;                       // fast wide-view site-derived surface
  }'''
if old_lod not in js:
    raise SystemExit('sourceTileZoom anchor not found')
js = js.replace(old_lod, new_lod, 1)

old_base = '''        if (this.displayedZoom === null) {
          // Always establish the quick base detail layer first. If the user zooms
          // rapidly to z8/z9, do not abandon z7 and leave the 1-km national image
          // enlarged on screen while dozens of finer tiles render.
          loadZoom = 7;'''
new_base = '''        if (this.displayedZoom === null) {
          // Establish the wide-view site-derived base first, then refine one LOD
          // at a time. The user never sees the coarse national GINI as a display
          // product while the Python tile server is available.
          loadZoom = 5;'''
if old_base not in js:
    raise SystemExit('initial loadZoom anchor not found')
js = js.replace(old_base, new_base, 1)

old_nodraw = '''        if (!drawTiles) {
          // A pan can expose uncached territory. Until one complete detail set is
          // ready for the new viewport, use one continuous national surface rather
          // than mixing coarse and fine rectangles.
          this.drawNationalFull(gl, matrix);
          this.updateUi();
          return;
        }'''
new_nodraw = '''        if (!drawTiles) {
          // Do not flash the coarse 1-km national image while high-resolution
          // site-derived tiles are loading. Keep the basemap clean until one
          // complete sharp viewport is ready.
          this.updateUi();
          return;
        }'''
if old_nodraw not in js:
    raise SystemExit('no-draw fallback anchor not found')
js = js.replace(old_nodraw, new_nodraw, 1)

js = js.replace('modeTitle.textContent = "National 1-km mosaic";\n          modeDetail.textContent = "Zoom in normally — no region selection required.";',
                'modeTitle.textContent = "High-resolution NEXRAD mosaic";\n          modeDetail.textContent = "Site-derived radar tiles are used at every zoom level.";')

js_path.write_text(js, encoding='utf-8')

py_path = Path('scripts/radar/serve_nexrad_detail_tiles.py')
py = py_path.read_text(encoding='utf-8')

old_candidate = '''    def _candidate_sites(self, bounds):
        candidates = []
        for station in self.station_table.values():
            distance_km = station_distance_to_tile_km(station, bounds)
            if distance_km <= site_renderer.AUTO_SITE_RANGE_KM:
                candidates.append((distance_km, station.site))
        candidates.sort(key=lambda item: item[0])
        return [site for _, site in candidates[: self.max_sites_per_tile]]'''
new_candidate = '''    def _candidate_sites(self, bounds, z):
        candidates = []
        for station in self.station_table.values():
            distance_km = station_distance_to_tile_km(station, bounds)
            if distance_km <= site_renderer.AUTO_SITE_RANGE_KM:
                candidates.append((distance_km, station.site))
        candidates.sort(key=lambda item: item[0])

        # Wide-view tiles cover much more geography and therefore need a larger
        # radar pool to remain a true site-derived national composite. Close-up
        # tiles can stay lean for speed because far fewer radars intersect them.
        if z <= 5:
            cap = 40
        elif z == 6:
            cap = 30
        elif z == 7:
            cap = 22
        else:
            cap = self.max_sites_per_tile
        return [site for _, site in candidates[:cap]]'''
if old_candidate not in py:
    raise SystemExit('candidate site anchor not found')
py = py.replace(old_candidate, new_candidate, 1)
py = py.replace('candidate_sites = self._candidate_sites(bounds)', 'candidate_sites = self._candidate_sites(bounds, z)', 1)
py = py.replace('workers = min(6, len(sites))', 'workers = min(10, len(sites))', 1)
py = py.replace('"mode": "viewport-driven hybrid NEXRAD slippy tiles",', '"mode": "all-zoom site-derived NEXRAD slippy pyramid",', 1)

py_path.write_text(py, encoding='utf-8')
print('Patched all-zoom site-derived high-resolution radar pyramid')
