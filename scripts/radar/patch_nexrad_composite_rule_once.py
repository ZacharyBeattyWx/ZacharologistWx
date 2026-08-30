from pathlib import Path

paths = [
    Path('scripts/radar/serve_nexrad_detail_tiles.py'),
    Path('scripts/radar/render_unidata_nexrad_site_mosaic.py'),
]

for p in paths:
    s = p.read_text(encoding='utf-8')
    s = s.replace(
        'The nearest valid individual radar replaces the national value before coloring.',
        'The strongest valid individual reflectivity is composited with the national value before coloring.'
    )
    s = s.replace(
        'nearest valid individual N0B site replaces fallback before colorization',
        'strongest valid individual N0B reflectivity is composited with national fallback before colorization'
    )
    s = s.replace(
        'national N0B fallback; nearest valid individual N0B site replaces fallback before colorization',
        'national N0B fallback; strongest valid individual N0B reflectivity is composited before colorization'
    )

    # Both active samplers used a nearest-radar distance field. For a reflectivity
    # mosaic that can erase storms when the nearest radar has blockage/attenuation.
    s = s.replace(
        '    best_distance = np.full(lon_grid.shape, np.inf, dtype=np.float64)\n',
        ''
    )
    s = s.replace(
        '        use = valid & (distance_km < best_distance)\n        output[use] = sampled[use]\n        best_distance[use] = distance_km[use]\n',
        '        # Reflectivity composite: retain the strongest valid return from any\n        # radar that sees this pixel. A nearby blocked/attenuated radar must never\n        # erase a storm that another WSR-88D sees clearly.\n        empty = output <= -9000\n        use = valid & (empty | (sampled > output))\n        output[use] = sampled[use]\n'
    )
    s = s.replace(
        '            # Nearest valid site wins in overlap zones. This avoids max-dBZ seam\n            # inflation and normally favors the radar with the best spatial sampling.\n            use = valid & (distance_km < best_distance)\n            chunk_dbz[use] = sampled[use]\n            best_distance[use] = distance_km[use]\n',
        '            # Reflectivity composite: strongest valid return wins. This avoids\n            # erasing convection when the geographically nearest radar is blocked or\n            # attenuated while a neighboring WSR-88D has a clean view.\n            empty = chunk_dbz <= -9000\n            use = valid & (empty | (sampled > chunk_dbz))\n            chunk_dbz[use] = sampled[use]\n'
    )
    s = s.replace(
        '        best_distance = np.full(lon_grid.shape, np.inf, dtype=np.float64)\n',
        ''
    )

    # Tile-server hybrid merge: preserve any stronger national composite value as
    # a safety floor while still letting finer individual-site structure exceed it.
    s = s.replace(
        '        combined = np.array(national_dbz, copy=True)\n        combined[site_valid] = site_dbz[site_valid]\n',
        '        combined = np.array(national_dbz, copy=True)\n        national_valid = np.isfinite(national_dbz) & (national_dbz > -9000)\n        only_site = site_valid & ~national_valid\n        both = site_valid & national_valid\n        combined[only_site] = site_dbz[only_site]\n        combined[both] = np.maximum(national_dbz[both], site_dbz[both])\n'
    )

    # Regional proof renderer uses the same safety-floor merge.
    s = s.replace(
        '    combined_dbz = np.array(national_dbz, copy=True)\n    site_valid = np.isfinite(site_dbz) & (site_dbz > -9000)\n    combined_dbz[site_valid] = site_dbz[site_valid]\n',
        '    combined_dbz = np.array(national_dbz, copy=True)\n    site_valid = np.isfinite(site_dbz) & (site_dbz > -9000)\n    national_valid = np.isfinite(national_dbz) & (national_dbz > -9000)\n    only_site = site_valid & ~national_valid\n    both = site_valid & national_valid\n    combined_dbz[only_site] = site_dbz[only_site]\n    combined_dbz[both] = np.maximum(national_dbz[both], site_dbz[both])\n'
    )

    p.write_text(s, encoding='utf-8')

print('Patched NEXRAD composite rule: strongest site + national safety floor')
