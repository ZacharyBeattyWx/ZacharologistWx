# Chase GPS: OwnTracks + town names

This change adds an optional OwnTracks HTTP receiver while keeping the existing Chase Admin GPS endpoint intact. OBS still polls `GET /api/chase/obs` using the same JSON contract. Its `location.label` is now the nearest recognizable town (e.g. `NEAR GREENSBORO, NC`), not numeric coordinates. NWS warning checks still use the private precise GPS location.

## Before deployment

1. Merge the PR, then deploy the updated Cloudflare Worker using your existing procedure (`cd cloudflare/chase-api` and `npx.cmd wrangler deploy` from PowerShell).
2. In `cloudflare/chase-api`, run `npx.cmd wrangler secret put CHASE_OWNTRACKS_PASSWORD`. Enter a new long random password generated with a password manager. **Do not reuse the admin token or GPS publish token**, or commit it to GitHub. Optional: set `CHASE_OWNTRACKS_USER` as a Worker secret; the default username is `zwxgps`.
3. Town names work by default through the NWS `/points` nearest-city API (U.S. locations). If you want Mapbox locality/place matching instead, set `MAPBOX_GEOCODING_TOKEN` as a Worker secret. **Mapbox requests use `permanent=true`, which requires an eligible billing setup**. This is optional; when Mapbox is unavailable the Worker falls back to NWS.
4. Verify the public OBS endpoint at `https://zacharologistwx.com/api/chase/obs`. It must never include raw GPS coordinates. If GPS is stale or location sharing is hidden, it must not claim a current town.

## Dedicated GPS iPhone: OwnTracks

1. Install the official OwnTracks app and allow **Always** location permission and Precise Location in iOS settings.
2. In OwnTracks settings choose **HTTP** connection mode with **HTTPS**, using endpoint `https://zacharologistwx.com/api/chase/owntracks`.
3. Enter username `zwxgps` (or the configured `CHASE_OWNTRACKS_USER`) and the separate `CHASE_OWNTRACKS_PASSWORD` in OwnTracks' authentication settings. Never share the password in chat or a screenshot.
4. Use **Move mode** during an active chase. The iOS default is about 100 m displacement or 300 s, which is too slow for a 90 s OBS freshness window. Start testing with 25 m displacement and 30 s interval, if available in your installed OwnTracks version. iOS can still throttle reports; these are requests, not guaranteed rates. Charge the phone during chases.
5. Leave the existing Chase Admin GPS publish feature available as a **manual fallback**, but do not run both publishers simultaneously unless troubleshooting. The DB accepts newer fixes only, preventing delayed packets from replacing newer records.
6. Test with OwnTracks in the foreground, then screen locked, then driving on a safe route. Observe the `location.updatedAt`, `ageSeconds`, `state`, and `alerts.state` in the public OBS JSON. Do not rely on this stream overlay as a replacement for NWS warnings.

## Server behavior and privacy

- `POST /api/chase/owntracks` accepts OwnTracks' standard HTTP Basic authentication, independently of the Admin and Bearer GPS credentials.
- The receiver accepts only recent `_type: location` reports, maps `tst` (Unix seconds), `acc` (meters), `cog` (degrees), and `vel` (km/h) to the existing GPS schema, and only updates the chase GPS fields. It never changes `chase_map_display` or other administrative fields.
- Other OwnTracks message types, zero-length messages, stale queued fixes, and duplicate/out-of-order fixes are safely acknowledged or ignored.
- `GET /api/chase/obs` continues to treat position as stale after 90 seconds. A stale location never implies the NWS has verified no active warnings.
- OBS geocoding only runs for a fresh, publicly enabled chase location. A failed lookup displays `LOCATION AREA UNAVAILABLE`; it does not reveal coordinates.
- The geocoded **town name is public**, and a town-level location may still reveal a broad position. Map display visibility still controls whether OBS shows it.
- NWS `/points` reverse location is a nearby named city, which may differ from the smaller community closest to you. Mapbox locality may be more granular.

## Test

In the repository, use Node.js' built-in test runner:

```powershell
node --test cloudflare/chase-api/tests/chase-obs.test.mjs cloudflare/chase-api/tests/chase-owntracks-town.test.mjs
```

Deployment is not automatic from this PR. It requires your review, the Cloudflare Worker deployment, secrets, and the OwnTracks iPhone setup.
