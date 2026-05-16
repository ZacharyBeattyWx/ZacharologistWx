# Radar Renderer Scaffold

This directory contains future infrastructure for the site-owned radar frame
service. It is not active on the website yet.

Current live radar remains unchanged:

- Clean Radar uses the Windy iframe fallback.
- Super-Res Radar uses IEM single-site loop frames for supported products.
- Hi-Res Site Radar forces IEM `N0B` and uses the same IEM loop system.
- `USE_CUSTOM_RADAR_FRAMES` remains `false` in `index.html`.

Future production output:

```text
/radar/frames.json
/radar/frames/{site}/{product}/{slug}.webp
```

Generated radar frames must be owned by this site. Do not hotlink or copy
rendered radar products from AgWx, Tehuano Labs, RadarScope, RadarOmega, or
other rendered radar frame services.

## Scripts

- `radar_config.json` - disabled-by-default renderer configuration.
- `fetch_nexrad.py` - scaffold for public NOAA/Unidata Level III fetching.
- `render_reflectivity.py` - scaffold for decoding/rendering reflectivity.
- `build_frames_catalog.py` - builds `radar/frames.json` from existing frames.
- `prune_frames.py` - dry-run-safe pruning placeholder.

The first milestone should target one site, one product, and a tiny frame
window, for example `KFCX`, `N0B`, and the latest 6 frames.
