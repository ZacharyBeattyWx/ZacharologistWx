// Position validation and OBS-safe weather status for the Zacharologist Wx chase Worker.
// No raw coordinates are returned to OBS when public map display is disabled.
export const GPS_FIX_MAX_AGE_MS = 60_000;
export const GPS_OBS_FRESH_MS = 90_000;
const MAX_FUTURE_DRIFT_MS = 30_000;
const NWS_POINT_ENDPOINT = 'https://api.weather.gov/alerts/active';
const NWS_PRIORITY = [
  'Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning',
  'Tornado Watch', 'Severe Thunderstorm Watch', 'Flash Flood Watch'
];

const finiteOrNull = value => (value === null || value === undefined || value === '')
  ? null : (Number.isFinite(Number(value)) ? Number(value) : null);

export function validateGpsSample(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'Expected a JSON object' };
  }
  const lat = finiteOrNull(payload.lat);
  const lon = finiteOrNull(payload.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { error: 'Invalid latitude or longitude' };
  }
  if (typeof payload.updatedAt !== 'string' || !payload.updatedAt.trim()) {
    return { error: 'A GPS fix timestamp is required' };
  }
  const timestamp = Date.parse(payload.updatedAt);
  if (!Number.isFinite(timestamp) || timestamp > now + MAX_FUTURE_DRIFT_MS || now - timestamp > GPS_FIX_MAX_AGE_MS) {
    return { error: 'GPS fix is stale or timestamp is invalid' };
  }
  const accuracy = finiteOrNull(payload.accuracy);
  const speed = finiteOrNull(payload.speed);
  const heading = finiteOrNull(payload.heading);
  if ((accuracy !== null && (accuracy < 0 || accuracy > 100_000)) ||
      (speed !== null && (speed < 0 || speed > 200)) ||
      (heading !== null && (heading < 0 || heading > 360))) {
    return { error: 'Invalid GPS accuracy, speed or heading' };
  }
  return { value: { lat, lon, accuracy, speed, heading, updatedAt: new Date(timestamp).toISOString() } };
}

function ringContains([lon, lat], ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const ax = Number(a[0]), ay = Number(a[1]), bx = Number(b[0]), by = Number(b[1]);
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;
    const cross = (lon - ax) * (by - ay) - (lat - ay) * (bx - ax);
    if (Math.abs(cross) < 1e-10 && lon >= Math.min(ax, bx) - 1e-10 && lon <= Math.max(ax, bx) + 1e-10 &&
        lat >= Math.min(ay, by) - 1e-10 && lat <= Math.max(ay, by) + 1e-10) return true;
    if ((ay > lat) !== (by > lat) && lon < (bx - ax) * (lat - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function pointInNwsGeometry(lat, lon, geometry) {
  if (!geometry) return true; // NWS /alerts/active?point filters county/zone alerts.
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates || [];
    return rings.length > 0 && ringContains([lon, lat], rings[0]) &&
      !rings.slice(1).some(ring => ringContains([lon, lat], ring));
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).some(polygon => pointInNwsGeometry(lat, lon, { type: 'Polygon', coordinates: polygon }));
  }
  return false;
}

export function selectPointAlerts(featureCollection, lat, lon, now = Date.now()) {
  if (!Array.isArray(featureCollection?.features)) throw new Error('Invalid NWS feature collection');
  const seen = new Set();
  return featureCollection.features.flatMap(feature => {
    const p = feature?.properties || {};
    const event = String(p.event || '').trim();
    if (!/\b(?:Warning|Watch)$/i.test(event) || (p.status && p.status !== 'Actual') ||
        /^(Cancel|Error)$/i.test(String(p.messageType || ''))) return [];
    const expiry = Date.parse(p.ends || p.expires || '');
    if (Number.isFinite(expiry) && expiry <= now) return [];
    if (!pointInNwsGeometry(lat, lon, feature.geometry)) return [];
    const id = String(feature?.id || p.id || p.identifier || `${event}:${p.areaDesc || ''}`);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, event, headline: String(p.headline || '').slice(0, 240),
      expires: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null }];
  }).sort((a, b) => {
    const rank = event => { const i = NWS_PRIORITY.indexOf(event); return i < 0 ? 100 : i; };
    return rank(a.event) - rank(b.event) || a.event.localeCompare(b.event);
  }).slice(0, 8);
}

export async function fetchPointAlerts(lat, lon, fetcher = fetch, now = Date.now()) {
  const url = `${NWS_POINT_ENDPOINT}?point=${lat.toFixed(5)},${lon.toFixed(5)}`;
  const response = await fetcher(url, {
    headers: {
      accept: 'application/geo+json',
      'user-agent': 'ZacharologistWx chase stream (https://zacharologistwx.com)'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`NWS point alerts HTTP ${response.status}`);
  return selectPointAlerts(await response.json(), lat, lon, now);
}

export async function createObsSnapshot(row, { now = Date.now(), fetcher = fetch, resolveTown = null } = {}) {
  const lat = finiteOrNull(row?.chase_lat);
  const lon = finiteOrNull(row?.chase_lon);
  const observed = Date.parse(row?.chase_location_updated || '');
  const hasCoordinates = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const age = Number.isFinite(observed) ? now - observed : Infinity;
  const fresh = hasCoordinates && age >= -MAX_FUTURE_DRIFT_MS && age <= GPS_OBS_FRESH_MS;
  const mapVisible = row?.chase_map_display === true || row?.chase_map_display === 1 || row?.chase_map_display === '1';
  const accuracy = finiteOrNull(row?.chase_accuracy);
  let label = !hasCoordinates ? 'LOCATION NOT CONNECTED' :
    !fresh ? 'GPS LOCATION STALE' : !mapVisible ? 'LOCATION HIDDEN' :
    'LOCATION AREA UNAVAILABLE';
  if (fresh && mapVisible && typeof resolveTown === 'function') {
    try {
      const nearest = await resolveTown(lat, lon);
      if (typeof nearest === 'string' && nearest.trim()) label = nearest.slice(0, 100);
    } catch (_error) {
      // A geocoder failure must never expose raw GPS coordinates.
    }
  }
  const location = {
    state: !hasCoordinates ? 'offline' : !fresh ? 'stale' : !mapVisible ? 'hidden' : 'live',
    label,
    updatedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : null,
    accuracyM: accuracy,
    ageSeconds: Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : null
  };
  const alerts = { state: 'unknown', items: [], checkedAt: null };
  let headline = 'GPS LOCATION UNAVAILABLE — CHECK CHASE TRACKING';
  if (fresh) {
    if (accuracy !== null && accuracy > 1000) {
      alerts.state = 'uncertain';
      headline = 'GPS ACCURACY TOO LOW TO VERIFY WARNINGS';
    } else {
      try {
        alerts.items = await fetchPointAlerts(lat, lon, fetcher, now);
        alerts.checkedAt = new Date(now).toISOString();
        alerts.state = 'live';
        headline = alerts.items.length ? (alerts.items[0].headline || alerts.items[0].event) :
          'NO NWS WARNINGS OR WATCHES AT CURRENT GPS LOCATION';
      } catch (_error) {
        alerts.state = 'unavailable';
        headline = 'NWS WARNING FEED UNAVAILABLE — CHECK OFFICIAL ALERTS';
      }
    }
  }
  return { version: 1, generatedAt: new Date(now).toISOString(), location, alerts,
    headline: headline.slice(0, 240) };
}
