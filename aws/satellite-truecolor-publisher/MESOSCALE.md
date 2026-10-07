# Flattened Mesoscale Viewer

The dedicated `zwx-satellite-mesoscale` stack publishes transparent Mercator
images from original NOAA ABI M1/M2 netCDF scans. Each frame carries its actual
geographic bounds and scan-grid identity. The viewer extends cyan state outlines
across a wider black geographic canvas without stretching the satellite image.

## Deployment

Run from the repository root in AWS CloudShell:

```bash
bash aws/satellite-truecolor-publisher/deploy-mesoscale-cloudshell.sh
```

The script creates only the separate mesoscale stack and container repository.
It reads the existing MRMS stack's bucket output but does not update that stack,
the existing satellite stack, radar, or Lightning. Scheduling stays disabled
until the seed returns nonempty products. It then enables a two-minute schedule.
Original scans are one minute apart; the first seed contains only two frames per
floater and the history builds on subsequent runs.

Default: GOES-East M1/M2 only. Set `MESOSCALE_PLATFORMS=East,West` before deploying
to add West. This adds compute, storage and delivery costs; it is not free.
Work is bounded to two new scans per floater per invocation, one concurrent
invocation, 60 retained frames per product within a 65-minute freshness window,
and 14-day logs. The five-minute margin accommodates scan publication delays.
Source downloads are
shared between True Color, Visible C02 and Clean IR C13. Completed scans are not
reprocessed; expired or old-location images are deleted after manifest commit.

## Viewer Behavior

- Mesoscale loops load up to 45 frames on mobile (viewport at most 880px) and
  60 on desktop. With All selected, this is roughly 45 minutes and one hour
  respectively at one-minute cadence. Other satellite sectors retain their
  existing 6/12/24-frame settings. Frame intervals still allow skipping scans.
- The decoded mesoscale cache is limited to the device's loop size and active
  frame URLs; switching products removes images outside the selected loop.
- History grows gradually after deployment; missing scans or a relocated floater
  can shorten the loop. Rendering remains limited to two scans per run, without
  a bulk backfill. Retaining more frames increases storage and viewer downloads,
  but does not increase the scheduled rendering rate.
- Prepared C02/C13 are preferred when available and fresh. Until deployment,
  the existing NOAA annotated playback stays available as the fallback.
- True Color uses the prepared publisher and C13 night imagery; it is not NOAA
  GeoColor. The True Color option reports deployment required until available.
- GeoColor remains the separate NOAA annotated feed; it is not flattened.
- Satellite-native coordinates come from each file's projection and x/y grid,
  not the rounded center printed in a NOAA JPEG filename.
- Frames from earlier moving-sector locations are excluded from the loop.
- Unsupported pole, limb and dateline-crossing footprints fail explicitly.
- The desktop maximize button hides the sidebar; the same button restores it.
- Header and playback stay outside the image, which is fully fitted, not cropped.

## Verification

```bash
node tests/verify-mesoscale-history.cjs
python3 tests/test_mesoscale_publisher.py
python3 tests/test_mesoscale_retention.py
```

The Python tests require the satellite publisher dependencies. A local read-only
NOAA seed render was also exercised for all three products with a mocked target
bucket. No AWS deployment or live cloud write is implied by passing local tests.
