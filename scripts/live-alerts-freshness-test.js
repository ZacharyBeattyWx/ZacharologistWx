(function (root) {
  'use strict';
  const MINUTE = 60000;
  function isCurrent(feature, now = Date.now()) {
    const p = feature?.properties || {};
    if (p.status && String(p.status).toLowerCase() !== 'actual') return false;
    const actions = [p.messageType, p.vtecAction, p.action].map(x => String(x || '').toUpperCase());
    if (actions.some(x => ['CAN', 'EXP', 'UPG', 'CANCEL', 'CANCELLATION'].includes(x))) return false;
    // Ends and CAP expiry can differ. The first valid end retires the alert.
    const ends = [p.expires, p.ends, p.end].map(Date.parse).filter(Number.isFinite);
    if (ends.length) return Math.min(...ends) > now;
    // A missing expiry is not permission to show a bulletin forever.
    // Use the actual issue time, never an ingestion or snapshot timestamp.
    const issued = Date.parse(p.sent || p.issued || '');
    const tropical = /hurricane|tropical storm|storm surge|typhoon/i.test(p.event || '');
    return Number.isFinite(issued) && issued <= now + 5 * MINUTE && now - issued < (tropical ? 12 : 6) * 60 * MINUTE;
  }
  function snapshotIsFresh(collection, now = Date.now()) {
    const generated = Date.parse(collection?.generatedAt || '');
    return Array.isArray(collection?.features) && Number.isFinite(generated) &&
      generated <= now + 5 * MINUTE && now - generated < 15 * MINUTE;
  }
  async function loadCollection(currentUrl, fetchJson, now = Date.now()) {
    let current;
    try { current = await fetchJson(currentUrl); } catch (_) { /* Official fallback below. */ }
    if (snapshotIsFresh(current, now)) return { collection: current, source: 'nwws' };
    const official = await fetchJson('https://api.weather.gov/alerts/active?status=actual');
    if (!Array.isArray(official?.features)) throw new Error('Invalid official alert feed');
    return {
      source: 'nws',
      collection: { ...official, generatedAt: new Date(now).toISOString(),
        features: official.features.map(feature => ({ ...feature,
          properties: { ...feature.properties, _nwsDeepLinkFallback: true } })) }
    };
  }
  root.AlertFreshness = { isCurrent, snapshotIsFresh, loadCollection };
})(typeof window === 'undefined' ? globalThis : window);
