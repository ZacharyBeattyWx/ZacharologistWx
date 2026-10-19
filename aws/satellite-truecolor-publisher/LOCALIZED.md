# Native Localized satellite sectors

Localized True Color now requests only its own manifest at
`satellite-truecolor/{east|west}/sectors/{sector-id}/manifest.json`.
There is no regional crop or GIBS fallback for this product. Missing, stale,
empty, mismatched or low-resolution manifests show an unavailable message
and disable playback. A sector is selectable before deployment so users can
retry it; its label says “Check availability”, not “Live”.

## Rendering and geometry

`localized-sectors.json` lists all 94 East and 28 West footprints, including
the current COD-named selector entries and the original named sectors. These
are our own footprints, not official COD sector metadata. Generated local
footprints keep their geographic centers and 700 km ground width (Georgia:
600 km), with a 16:9 Web Mercator aspect. They are no longer shifted to fit a
larger prepared region. Legacy Florida covers the panhandle through the Keys.
The catalog parity check prevents viewer and publisher geometry from drifting.

The localized worker samples C01/C02/C03 directly from each scan's ABI RadC
fixed grid, including full C02 stride 1 detail, into the sector's own EPSG:3857
grid. C13 supplies nighttime imagery. Output is 2560 pixels wide at WebP
quality 88; height follows the projected bbox rather than forcing a square.
Output dimensions do not imply a new sensor resolution: source channels
retain their actual ABI sampling. Manifests report the output grid spacing.
Images have versioned immutable paths, dimensions and scan timestamps.
Manifests declare `nativeLocalized: true` and `projection: EPSG:3857`.
Existing vector outlines use that same projected bbox.
Increment `NATIVE_LOCALIZED_RENDER_VERSION` when changing catalog geometry,
output dimensions or the rendering recipe so immutable frame URLs and old
checked scans cannot be reused for a different render.

## Isolated deployment

Deploy **only** `deploy-localized-cloudshell.sh` for this change. It builds the
updated image and creates/updates the separate `zwx-satellite-localized` stack.
It does not update the regional, Full Disk, RGB, Mesoscale, radar, MRMS or
Lightning stacks. Its IAM write access is limited to Localized satellite keys.
It performs no Git cleanup or Docker cache/image pruning.

From a fresh checkout of this change in AWS CloudShell, run:

```bash
bash aws/satellite-truecolor-publisher/deploy-localized-cloudshell.sh
python3 aws/satellite-truecolor-publisher/verify-localized-live.py
```

Keep unrelated CloudShell working directories intact; clone the PR branch into
a new directory or use an existing clean checkout of the reviewed commit.
`AWS_REGION`, `LOCALIZED_STACK_NAME`, `SOURCE_STACK_NAME`, `TARGET_BUCKET`,
`ECR_REPOSITORY`, `SCHEDULE_STATE`, and `IMAGE_URI` may be overridden.
An `IMAGE_URI` override must reference an image containing this publisher and
its new catalog, not an older regional image.
CloudShell's Docker daemon must be available, with sufficient disk space.

There are eight bounded invocations every five minutes: six East shards and
two West shards, each with at most 16 sectors. They share downloads within
each invocation and render at most one new scan per sector. Timeout is 240
seconds, maximum event age is 60 seconds, retries are disabled and concurrency
is capped at eight. This adds compute and S3 storage costs. Monitor Lambda
duration/errors/throttling after rollout; a shard approaching its time budget
requires more shards, not a longer timeout that overlaps the next cycle.
The first cycle publishes one frame per sector; a full 25-frame history fills
over roughly two hours. Deployment completion alone does not verify imagery.

The verifier checks **every** dedicated public manifest, its identity, bbox,
projection, cadence, chronology, dimensions, freshness and newest WebP's actual
decoded dimensions. It exits nonzero until all selected sectors pass. For a
quick representative check:

```bash
python3 aws/satellite-truecolor-publisher/verify-localized-live.py --sector loc-cod-NC_VA
```

The Lambda image includes Pillow. If CloudShell's Python lacks it, run
`python3 -m pip install --user Pillow` before the public verification.
Do not describe Localized as live until the public verifier succeeds.

## Mobile and playback

Localized drawing permits DPR 2. Mobile startup fetches only the newest frame;
requesting playback warms the existing selected loop with three workers.
Decoded Localized frames are stored once as canvases, at most 1536 pixels on
mobile or 2048 on desktop. A second limit allocates at most 128 MiB mobile /
224 MiB desktop across the full available loop's cached RGBA pixels, excluding
the displayed canvas, outlines, browser/compressed-image caches and transient
decodes. Playback reuses those canvases instead of retaining a duplicate
rendered canvas per frame. This bounds quality against loop memory while
preserving aspect ratio, pan/fit controls, speed and the newest-frame hold.
RGB/native products and Mesoscale retain their existing source selection.

## Verification

```bash
python3 -m pip install -r aws/satellite-truecolor-publisher/requirements.txt
python3 -m unittest discover -s aws/satellite-truecolor-publisher -p 'test_*.py'
python3 -m unittest discover -s tests -p 'test_mesoscale*.py'
python3 test_ir_palette.py
node tests/verify-localized-satellite.cjs
node tests/verify-mobile-satellite.cjs
node verify-satellite-end-pause.cjs
node verify-satellite-speed.cjs
```

For browser regression checks, install Playwright and Chrome in the test
environment, then run `node tests/verify-localized-browser.cjs`.
The browser test uses synthetic imagery and intercepted network responses;
it verifies behavior, not live AWS deployment or the quality of real clouds.
It covers mobile DPR 3 and desktop playback, dimensions, no broad/GIBS
fallback, missing images and missing/mismatched/stale unavailable states,
decoded pixel budgets, shared playback canvases, outline alignment and refresh
reuse. The static routing test also preserves the existing RGB crop path.

## Rollback

Set `SCHEDULE_STATE=DISABLED` and rerun the localized deployment script with
the same `IMAGE_URI`, or disable its two EventBridge rules. This stops only
Localized publishing. Once cached frames age beyond 45 minutes the viewer
shows unavailable. Existing regional products continue independently.
