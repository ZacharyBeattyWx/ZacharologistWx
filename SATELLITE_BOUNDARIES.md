# Satellite Administrative Boundaries

The viewer retains the existing detailed US Census 2025 1:500,000 outlines in
`assets/satellite-state-boundaries-2025.geojson` unchanged, and supplements them
with `assets/satellite-canada-mexico-boundaries.geojson`:

- Canada: ten provinces and three territories.
- Mexico: 31 states and Mexico City, excluding Natural Earth's unnamed
  pseudo-division `MX-X01~`.
- Source: Natural Earth 1:10m Admin 1 states/provinces 5.1.1, public domain.
  https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/
- Simplification: 0.001 degrees with topology preserved; five decimal places.
  These are weather-viewer reference outlines, not survey-grade boundaries.

Both datasets use geographic longitude/latitude. The existing renderer projects
them using the exact frame's Mercator bounds and mobile pan/fit transform. No
image colors, source pixels, or publisher georeferencing are modified. A missing
supplement falls back to the US outlines rather than disabling all boundaries.
The supplement is fetched once and can be cached; it requires no new map service
or AWS publisher deployment.

## Rebuild

Download the official archive:
https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip

Install `pyshp` and `shapely`, then run from the repository root:

```bash
python scripts/build-north-america-boundaries.py ne_10m_admin_1_states_provinces.zip assets/satellite-canada-mexico-boundaries.geojson
node tests/verify-north-america-boundaries.cjs
```

The builder checks that exactly 13 Canadian and 32 Mexican divisions remain.
Tests also check closed finite geographic rings, unique subdivision codes, and
that supplement failure does not discard existing US boundaries.

Desktop mesoscale product selection now lives in the left sidebar. The image no
longer reserves a full-width top menu bar; only a compact title overlay remains.
Mobile retains its existing single selector above the fitted image. The same DOM
control moves between these placements when crossing the 880px breakpoint.
