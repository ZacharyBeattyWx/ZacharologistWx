# Cost-controlled public weather restoration — November 1, 2026

## Delivery

The homepage and its regional-radar modal continue to use `mosaic-radar-home.html`.
That page now uses NOAA's public MRMS ImageServer, including its actual CONUS raster
catalog and observation timestamps. Exports lock an exact raster ID: requested
historical observations cannot silently become the newest frame. Six recent frames
are available; playback and pan/zoom use viewport-sized exports (1536×1024 maximum).

This is explicitly labeled a **temporary public-service view**, using NOAA colors.
It is a rendered MRMS base-reflectivity service, not the former custom numeric
MRALA/native-chunk product. The baked native renderer, GPU interpolation, and
palette code remain intact but dormant. The old legend is hidden because it does
not describe NOAA's colors. Native detail and prewarm hooks are disabled on this
page; `nexrad-main-live-overlay.js` also exits before polling CloudFront.

No AWS service is enabled, invoked by this restoration, or reconfigured. No new
Worker, cron, R2 pipeline, container, queue, or GitHub scheduled workflow is added.

## Freshness and limits

- Radar catalog refresh: once per two minutes per visible page, with timeouts.
- Radar exports: at most 12 per rolling minute per page; eight image blobs in
  memory, browser cache reuse, one image request at a time, pan debounce.
- Hidden radar pages stop animation and skip refresh/export work. In-flight
  responses cannot replace the display after a visibility or viewport change.
- Radar is hidden when the newest known observation exceeds 20 minutes; no
  success is inferred from the time a request completed. Older playback frames
  show their observation time, age, and a history label.
- Public alert pages use the official NWS API, independently of ECS/NWWS and the
  Cloudflare Durable Object's ingestion state. There is no NWWS WebSocket.
- One national alert request per visible page per minute replaces 38 parallel
  homepage state requests. Pagination is bounded to five pages and failures never
  become an empty success. Concurrent/manual refreshes share a one-minute cache
  and failure cooldown. Selected-location queries are additional NWS requests,
  with a one-minute cache per point and a request timeout.
- Cancellation, upgrade, non-Actual, expiry, invalid-time and missing-expiry
  protections run in the public pages. Refresh errors show an offline/failure
  label and preserve the last verification time; retained records still expire.
- These are browser-side usage controls, not an enforceable global rate limit.

## Existing infrastructure inspected

- `cloudflare/chase-api`: `/api/nws-alerts` already proxies NWS with edge caching;
  `/api/nws-alert-snapshot` reads an R2 snapshot. `/api/live-alerts/*` forwards to a
  Durable Object populated by NWWS ingest. The restoration bypasses that ingest.
- `workers/mrms-watchdog` is retired, has no configured cron, and identifies AWS as
  the former publisher. It remains retired.
- `workers/radar-h2-dispatcher` dispatches a GitHub radar workflow; its checked-in
  configuration has no cron. It is not used or deployed here.
- Existing NWS snapshot and other weather-rendering workflows remain unchanged.
  Their usage, existing R2/Cloudflare bills, and residual AWS storage charges are
  outside the incremental cost of these frontend changes.

## Validation and release

Run:

```text
node --test tests/cost-controlled-weather.test.cjs tests/homepage-alerts.test.cjs tests/homepage-newsroom.test.cjs
node tests/live-alerts-freshness.test.cjs
git diff --check
```

Live HTTP checks on November 1 at approximately 10:25 p.m. Eastern returned:
six NOAA CONUS frames, a newest observation about three minutes old, a decoded
1536×1024 PNG (444,359 bytes), and browser CORS permission for the site origin.
NWS returned a valid collection of 428 active alerts with unrestricted CORS.
The radar image was visually inspected. Unit/runtime tests also simulate radar
rendering, history, cache reuse, stale removal, alert replacement and feed failure.

Full interactive browser validation remains incomplete: the in-app browser could
not reach the local preview and native Chrome accessibility timed out. Publish
through the pull request, then smoke-test the homepage iframe, radar pan/playback,
alerts, empty state, deep links, and mobile layout on the actual domain. A PR does
not itself change production hosting. No Cloudflare deployment is required.

## Incremental costs

Expected new paid infrastructure cost: **$0/month**. NOAA supplies the rendered
radar; NWS supplies free alert data. Hosting and the existing Mapbox basemap remain
in use. This is not a promise that the whole account bill is zero: existing Mapbox,
Cloudflare, GitHub, and residual AWS resources retain their own usage/pricing.
At rest, a visible radar page makes 30 catalog checks/hour and at most one new
image for a changed raster; deliberate playback/viewport changes can reach the
12 exports/minute cap. A 444 KB national-image example is about 2.7 MB for six
uncached frames. There are no new uncapped paid server requests in this design.

Official source documentation:

- [NOAA MRMS image service](https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer)
- [NWS API documentation, free usage and rate limits](https://www.weather.gov/documentation/services-web-api)

Future native-resolution processing requires a separately measured non-AWS
publisher and an explicit spending limit. Do not resume AWS publishers to restore
that product.
