# Level II Scanner Next Phase

## Current stable state

Level II dispatch now uses:

AWS Lambda ? GitHub repository_dispatch ? render-level2-radar.yml

Working paths:
- Normal source-event dispatch works.
- Scheduled watchdog dispatch works.
- GitHub Actions logs now show dispatch source/reason/source_key.
- All 12 configured sites publish 25 frames.
- Cloudflare Level II dispatch vars are still retained as rollback.

Configured sites:
KFCX, KRAX, KGSP, KLTX, KMRX, KJKL, KRLX, KLWX, KMHX, KAKQ, KCAE, KCLX

AWS Lambda:
zacharologistwx-level2-scanner

EventBridge Scheduler:
zacharologistwx-level2-watchdog

Watchdog payload:
{
  "watchdog": true,
  "dispatch_target": "github",
  "stale_seconds": 300,
  "max_dispatches": 3
}

## Important finding

The watchdog fixes render freshness, but not necessarily scan freshness.

The checker now separates:
- RenderAgeMin: how recently the pipeline updated frames.json
- ScanAgeMin: how old the actual latest radar scan is

Example issue observed:
A site can have a fresh RenderAgeMin but an old ScanAgeMin if the renderer reruns using old source data.

## Next phase

Build source-aware watchdog v2.

Goal:
Before dispatching a stale site, Lambda should check the latest actual Level II source key for that site.

Logic:
1. Fetch latest source key available for the site.
2. Compare latest source scan time to current manifest latestScan.
3. Dispatch only if the source key is newer than what the manifest already has.
4. Ignore metadata files like *_MDM.
5. Log source_not_newer when no newer scan exists.

This prevents rerendering old data and calling it fresh.

## Do not remove yet

Keep these Lambda environment variables for rollback:
- CLOUDFLARE_LEVEL2_URL
- RADAR_DISPATCH_SECRET

Current production target should remain:
LEVEL2_DISPATCH_TARGET = github