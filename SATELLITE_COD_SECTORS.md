# Continental-U.S. sector catalog

Reference: https://weather.cod.edu/satrad/ (public selector, inspected 2026-10-07).

The viewer adds 88 localized reference choices and 32 sub-regional reference
choices across GOES-East/West. Canada-only, Mexico-only, Caribbean, Alaska and
Hawaii choices are deferred. Great Lakes and U.S. coastal views remain included.
This is a CONUS-focused subset, not a claim of exhaustive COD catalog parity.

COD IDs are retained as `codId` for comparing selections. Display names expand
abbreviations and correct Sioux Falls spelling. The source selector exposes
marker pixel coordinates, not geographic image bounds. Centers and crop bounds
here are independently authored, approximate geographic framing. They do not
reproduce COD's projection or exact extents.

Localized views target a 700-km ground width (600 km for Georgia); sub-regional
views target 1,400 km (1,000 km for Key West), at 16:9 in Mercator. Crops are
shifted or reduced to fit an existing prepared parent without losing the named
reference center. A platform only lists crops its regional feed can cover.
Desktop aspect fitting does not expand these fixed footprints beyond their
source coverage. The existing phone Fit/swipe controls remain unchanged.

Georgia & Carolinas (`loc-atl`) moves to Sub-Regional, preserving that saved ID.
Georgia is a separate, tighter Localized choice. Other old saved IDs map to new
equivalent choices. The mobile selector and desktop sidebar share the catalog.

Publishing footprints remain separate in `SAT_PUBLISHED_SECTORS`. True Color
selects the smallest containing, existing prepared parent, never a fabricated
manifest for a new client crop. Every listed new crop has a containing prepared
parent configured by the existing publisher with a 1-km target. This does not
guarantee a particular deployed manifest version or improve the native sensor
resolution. Existing manifest validation and regional fallback remain available
if a prepared parent is unavailable. The displayed resolution still comes from
the manifest actually loaded.

No AWS deployment or new render jobs are needed for this catalog. Pixel colors,
boundary projection, native products, mesoscale, radar and Lightning rendering
are unchanged. IR remains limited by its native channel resolution; zooming a
crop is not additional measured detail.

## Verification

From the repository root:

```sh
node verify-cod-sectors.cjs
```

The test checks JavaScript syntax, unique IDs, catalog coverage across platforms,
prepared-parent containment and URLs, reference-center retention, 16:9 framing,
fixed viewport bounds, smaller Georgia coverage, category placement and aliases.
Existing mobile navigation and mesoscale-history tests also passed against the
edited viewer. Interactive browser screenshots could not be taken because the
local browser automation runtime failed to start. Visual review remains required
before merging; no COD-equivalent visual sharpness claim is made from unit tests.
