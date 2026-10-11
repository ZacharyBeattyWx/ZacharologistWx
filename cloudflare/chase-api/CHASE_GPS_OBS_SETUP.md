# Chase GPS → NWS alerts → OBS V5

This opt-in integration reuses the existing Cloudflare Chase Worker and D1 table.
No radar page or renderer is changed.

## Deploy order

1. Review and merge this feature branch.
2. Deploy `cloudflare/chase-api` with Wrangler using the project's normal process.
3. Create a **different secret from the Chase Admin token**, e.g. a random 32-byte value:
   ```bash
   cd cloudflare/chase-api
   npx wrangler secret put CHASE_GPS_TOKEN
   ```
   Paste the random value at the interactive prompt. Never commit it.
4. In the private `admin.html` page, open GPS, save that GPS-only token, and select
   **Start Auto Publish**. Do not click **Enable GPS** first: Auto Publish ensures the
   watch is active without toggling it off.
5. Keep Chase Admin in the foreground with the iPhone unlocked while testing.
6. If publishing your approximate position is intended, use **Map Display ON**
   (requires the Admin token). When off, OBS reads `LOCATION HIDDEN` while
   warning matching can still use your current GPS location privately.
7. In OBS V5, replace the local `overlay.js` and `overlay.css` with the included
   live-overlay package and refresh the three graphics Browser Sources.

## Endpoints

- `POST /api/chase/location`: Bearer `CHASE_GPS_TOKEN`, JSON object:
  ```json
  {
    "lat": 35.12345, "lon": -80.54321,
    "accuracy": 12, "heading": 140, "speed": 10,
    "updatedAt": "2026-10-11T18:00:00.000Z"
  }
  ```
  This endpoint **only** updates the GPS columns. Duplicate/out-of-order samples
  return HTTP 409. Stale/invalid samples return HTTP 400. It cannot change
  map visibility, briefing, stream settings or Admin token.
- `GET /api/chase/obs`: public, read-only JSON with coarse/hidden location,
  position freshness, NWS alert tags and a headline for OBS. Never includes
  raw coordinates, private tokens or the full Admin object.
- `GET /api/chase/status`: unchanged public Chase Dashboard endpoint.

NWS point-alert results are obtained with `api.weather.gov/alerts/active?point=`,
validated against polygons when supplied, and filtered to active warnings/watches.
The Worker caches the OBS response at the edge for 45 seconds to avoid excessive
NWS requests; client polling should remain at 30 seconds or slower.

**Missing GPS, weak accuracy, HTTP errors, stale observations, and failed NWS
responses must NEVER be displayed as 'No active warnings'.** The OBS client
shows UNKNOWN/STALE/UNAVAILABLE instead.

## iPhone caveat

This is automatic **foreground** GPS reporting, not reliable background tracking.
iOS can suspend browser timers/geolocation when Safari is hidden or the screen
locks. For a locked-screen, multi-hour chase tracker, use a native iOS app with
background-location entitlement reporting to this secured endpoint.

## Validation

```bash
node --check cloudflare/chase-api/src/index.js
node --check cloudflare/chase-api/src/chase-obs.js
node --test cloudflare/chase-api/tests/chase-obs.test.mjs
```

Before any public stream, test fresh fixes, expired fixes, no applicable alerts,
known NWS warning polygons, warning expiry, map-display privacy, and cellular
outages. This overlay supplements but never replaces official NWS warnings.
