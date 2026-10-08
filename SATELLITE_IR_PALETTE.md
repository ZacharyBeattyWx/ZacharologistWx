# Clean IR enhancement

Visual reference: the user's COD Clean Longwave IR comparison and public viewer
https://weather.cod.edu/satrad/ . This is an independently authored COD-style
mapping, not a verified copy of COD's exact enhancement table. The Cloud Top
Temperature (`acht`) legend visible in the reference is an independently selected
overlay; it must not be assumed to be the definitive ABI C13 enhancement table.

The old palette placed orange at 205 K and yellow at 215 K and stayed red at the
cold end. The new mapping adds a white anchor at 193 K, a black extreme-cold tail
at 180 K, red at 200 K, orange at 210 K, yellow at 213 K, green at 226 K, blue at
235 K, purple at 240 K and white at 245 K. Warmer pixels continue through grayscale
to black at 300 K. Intermediate values interpolate in RGB. Temperatures remain
native measured brightness temperatures in Kelvin, and invalid samples remain
masked. This mapping intentionally is not monotonic in brightness; both a warm
surface and an extremely cold core can be dark.

Only `clean_ir_rgb` is changed. The other RGB recipes, True Color's night-side
recipe, resampling, geographic grids, boundaries, radar and Lightning are not
changed. Viewer-only recoloring of compressed RGB frames is not used: it cannot
reliably recover the underlying temperature.

## Versions and Deployment

Native Clean IR frames move from version 4 to 5. Mesoscale C13 frames move from
version 1 to 2; True Color and C02 remain version 1. Mesoscale manifests record
renderVersion and palette ID. On migration, only old C13 checked scans and frames
are excluded from the new loop. A successful new manifest is published before
old unreferenced C13 frames are removed. If no new IR frame renders, the previous
IR manifest and files remain available. Immutable frame URLs are not overwritten.

The existing two-scan invocation budget, two-minute schedule, 60-frame retention
and geometry isolation remain in place. The new IR history grows gradually rather
than mixing palettes or launching an expensive complete-history render. Expect a
shorter IR loop immediately after deployment, then about an hour to fill history.

This requires an AWS publisher deployment after merging. Deploy the independent
mesoscale publisher for M1/M2 first. The shared regional/full-disk publisher must
also be redeployed to give ordinary Clean IR sectors the same palette. Do not
redeploy radar or Lightning stacks. No AWS deployment has been performed here.

## Tests

Run from the repository root:

```sh
python test_ir_palette.py
```

The tests extract the relevant functions without importing AWS clients. They
check temperature anchors, invalid-pixel masking, no input mutation, valid RGB
range, version isolation, IR-only bounded migration, manifest-before-delete
ordering, preservation on failed rendering and completed-scan reuse.

Full local mesoscale publisher tests also cover geographic coordinate grids,
60-frame retention, scan reuse and sector/budget isolation. A palette ramp was
generated and visually checked. An actual post-deployment NOAA storm comparison
is still needed before claiming exact COD equivalence.
