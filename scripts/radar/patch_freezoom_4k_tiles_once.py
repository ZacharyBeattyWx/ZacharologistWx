from pathlib import Path

js_path = Path('scripts/radar/nexrad-freezoom-webgl.js')
js = js_path.read_text(encoding='utf-8')

js = js.replace('const MAX_GPU_TILES = 160;', 'const MAX_GPU_TILES = 64;')
js = js.replace('const MAX_FETCHES = 8;', 'const MAX_FETCHES = 6;')

old_lod = '''  function sourceTileZoom(mapZoom) {
    // Progressive LOD: get useful detail quickly, then refine only after the
    // next complete viewport is ready. The currently displayed LOD stays put
    // during the camera zoom, so there is no tile-pyramid rebuild under the user.
    if (mapZoom >= 8.75) return 9;  // ~120 m rendered pixels
    if (mapZoom >= 7.45) return 8;  // ~240 m rendered pixels
    return 7;                       // ~480 m rendered pixels
  }'''
new_lod = '''  function sourceTileZoom(mapZoom) {
    // 1024px radar tiles: z7 already lands near the native ~240 m N0B sampling
    // across much of the CONUS, which recreates the earlier 4K-style detail with
    // far fewer requests than z8/512. z8 is a closer-zoom refinement only.
    if (mapZoom >= 8.60) return 8;  // ~120 m rendered pixels (oversampled refinement)
    return 7;                       // ~240 m rendered pixels (native-detail base)
  }'''
if old_lod not in js:
    raise SystemExit('sourceTileZoom anchor not found')
js = js.replace(old_lod, new_lod, 1)
js_path.write_text(js, encoding='utf-8')

py_path = Path('scripts/radar/serve_nexrad_detail_tiles.py')
py = py_path.read_text(encoding='utf-8')
py = py.replace('DEFAULT_TILE_SIZE = 512', 'DEFAULT_TILE_SIZE = 1024')
py = py.replace('DEFAULT_CACHE_TILES = 160', 'DEFAULT_CACHE_TILES = 96')
py = py.replace('DEFAULT_MAX_SITES_PER_TILE = 10', 'DEFAULT_MAX_SITES_PER_TILE = 18')
py = py.replace('3. The nearest valid individual radar replaces the national value before coloring.',
                '3. The strongest valid individual-radar reflectivity supplies detail wherever site coverage exists.')

old_merge = '''        combined = np.array(national_dbz, copy=True)
        national_valid = np.isfinite(national_dbz) & (national_dbz > -9000)
        only_site = site_valid & ~national_valid
        both = site_valid & national_valid
        combined[only_site] = site_dbz[only_site]
        combined[both] = np.maximum(national_dbz[both], site_dbz[both])
        rgba = palette_renderer.colorize_dbz_grid_for_tiles(combined)'''
new_merge = '''        # Site data is the primary high-resolution surface. The national 1-km
        # mosaic is used only where no individual N0B site provides a valid sample.
        # This prevents coarse 1-km blocks from surviving inside otherwise sharp
        # detail tiles. sample_site_sweeps() already composites the strongest valid
        # return from the expanded surrounding-radar pool.
        combined = np.array(national_dbz, copy=True)
        combined[site_valid] = site_dbz[site_valid]
        rgba = palette_renderer.colorize_dbz_grid_for_tiles(combined)'''
if old_merge not in py:
    raise SystemExit('hybrid merge anchor not found')
py = py.replace(old_merge, new_merge, 1)
py_path.write_text(py, encoding='utf-8')

print('Patched 1024px native-detail tiles, expanded radar pool, and site-primary merge')
