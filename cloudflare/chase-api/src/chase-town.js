// Nearest recognizable town for a public OBS label (never an address).
// Prefer Mapbox permanent geocoding if explicitly configured, otherwise NWS /points.
// The OBS edge response is cached, so temporary Mapbox results must NOT be used.
function cleanName(value) {
  return String(value || '').replace(/[\r\n\t<>]/g, '').trim().slice(0, 70);
}
function stateAbbr(code, fallback) {
  const raw = cleanName(code);
  const last = raw.split('-').pop();
  return /^[A-Z]{2}$/i.test(last) ? last.toUpperCase() : cleanName(fallback);
}
function label(name, state) {
  const n = cleanName(name), s = cleanName(state);
  return n && s ? 'NEAR ' + n.toUpperCase() + ', ' + s.toUpperCase() : null;
}

export function townFromMapbox(data) {
  const features = Array.isArray(data?.features) ? data.features : [];
  for (const type of ['locality', 'place']) {
    const f = features.find(feature => feature?.properties?.feature_type === type);
    if (!f) continue;
    const p = f.properties || {};
    const region = p.context?.region || {};
    const result = label(p.name || p.name_preferred, stateAbbr(region.region_code, region.name));
    if (result) return result;
  }
  return null;
}

export function townFromNws(data) {
  const loc = data?.properties?.relativeLocation?.properties || {};
  return label(loc.city, loc.state);
}

export async function reverseTownLabel(lat, lon, { mapboxToken, fetcher = fetch } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (mapboxToken) {
    try {
      const endpoint = new URL('https://api.mapbox.com/search/geocode/v6/reverse');
      endpoint.searchParams.set('longitude', String(lon));
      endpoint.searchParams.set('latitude', String(lat));
      endpoint.searchParams.set('types', 'locality,place');
      endpoint.searchParams.set('language', 'en');
      // Required for caching the resulting public OBS response.
      endpoint.searchParams.set('permanent', 'true');
      endpoint.searchParams.set('access_token', mapboxToken);
      const response = await fetcher(endpoint.toString(), {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const found = townFromMapbox(await response.json());
        if (found) return found;
      }
    } catch (_error) { /* Fall back to NWS. */ }
  }
  try {
    const response = await fetcher(
      'https://api.weather.gov/points/' + lat.toFixed(4) + ',' + lon.toFixed(4),
      {
        headers: {
          accept: 'application/geo+json',
          'user-agent': 'ZacharologistWx chase stream (https://zacharologistwx.com)'
        },
        signal: AbortSignal.timeout(5000)
      }
    );
    return response.ok ? townFromNws(await response.json()) : null;
  } catch (_error) { return null; }
}
