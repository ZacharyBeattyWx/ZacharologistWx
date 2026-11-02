/* Public weather feeds: no AWS ingest, credentials, or background compute. */
(function (root) {
  'use strict';
  const NWS_URL = 'https://api.weather.gov/alerts/active?status=actual';
  const MINUTE = 60000;
  function isCurrent(feature, now = Date.now()) {
    const p = feature?.properties || {};
    if (p.status && p.status.toLowerCase() !== 'actual') return false;
    if ([p.messageType, p.vtecAction, p.action].some(x => /^(CAN|EXP|UPG|CANCEL|CANCELLATION)$/i.test(x || ''))) return false;
    const issued = Date.parse(p.sent || p.issued || '');
    if (Number.isFinite(issued) && issued > now + 5 * MINUTE) return false;
    const ends = [p.expires, p.ends, p.end].map(Date.parse).filter(Number.isFinite);
    if (ends.length) return Math.min(...ends) > now;
    const hours = /hurricane|tropical storm|storm surge|typhoon/i.test(p.event || '') ? 12 : 6;
    return Number.isFinite(issued) && issued <= now + 5 * MINUTE && now - issued < hours * 60 * MINUTE;
  }
  async function json(url, fetcher = root.fetch.bind(root)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetcher(url, { signal: controller.signal, cache: 'no-cache',
        headers: { Accept: 'application/geo+json, application/json' } });
      if (!response.ok || Number(response.headers.get('age') || 0) > 120) throw new Error('Weather feed unavailable or stale');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  // One national request replaces the homepage's 38 parallel state requests.
  // Follow official pagination, but never publish a truncated success.
  async function fetchAlerts(fetchJson = json, now = Date.now()) {
    const features = [];
    let url = NWS_URL;
    const visited = new Set();
    while (url) {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://api.weather.gov' || parsed.pathname !== '/alerts/active' || visited.has(url) || visited.size >= 5) throw new Error('Incomplete NWS alert collection');
      visited.add(url);
      const data = await fetchJson(url);
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Invalid NWS alert collection');
      features.push(...data.features);
      url = data.pagination?.next || '';
    }
    const unique = new Map(features.filter(f => f.type === 'Feature' && isCurrent(f, now)).map(f => [f.id || f.properties?.id, f]));
    return { type: 'FeatureCollection', features: [...unique.values()], source: 'Official NWS API', verifiedAt: now };
  }
  function createAlertLoader(fetchJson = json, clock = Date.now) {
    let saved, pending, lastAttempt = -Infinity;
    return async function () {
      const now = clock();
      if (pending) return pending;
      if (saved && now - saved.verifiedAt < MINUTE) return saved;
      if (now - lastAttempt < MINUTE) throw new Error('NWS refresh cooling down; retry in one minute');
      lastAttempt = now;
      pending = fetchAlerts(fetchJson, now).then(data => (saved = data)).finally(() => { pending = null; });
      return pending;
    };
  }
  root.LiveWeatherFeeds = { isCurrent, json, fetchAlerts, createAlertLoader, loadAlerts: createAlertLoader() };
  if (typeof module !== 'undefined') module.exports = root.LiveWeatherFeeds;
})(typeof window === 'undefined' ? globalThis : window);
