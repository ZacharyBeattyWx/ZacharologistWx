const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const feeds = require('../scripts/live-weather-feeds.js');
const radar = require('../scripts/radar/public-mrms.js');
const now = Date.parse('2026-11-02T03:00:00Z');
const feature = (id, props = {}) => ({ type: 'Feature', id, properties: { event: 'Tornado Warning', status: 'Actual', sent: new Date(now - 60000).toISOString(), expires: new Date(now + 60000).toISOString(), ...props } });
const collection = features => ({ type: 'FeatureCollection', features });
test('retire cancellations, tests, expired products, and future issue times', () => {
  for (const p of [{ status: 'Test' }, { messageType: 'Cancel' }, { vtecAction: 'UPG' }, { ends: new Date(now - 1).toISOString() }, { sent: new Date(now + 3600000).toISOString() }]) assert.equal(feeds.isCurrent(feature('a', p), now), false);
  assert.equal(feeds.isCurrent(feature('a'), now), true);
  assert.equal(feeds.isCurrent(feature('a', { expires: '', sent: 'invalid' }), now), false);
});
test('one national request, pagination, deduplication, and empty success', async () => {
  const urls = [];
  const result = await feeds.fetchAlerts(async url => { urls.push(url); return urls.length === 1 ? { ...collection([feature('a')]), pagination: { next: 'https://api.weather.gov/alerts/active?cursor=2' } } : collection([feature('a'), feature('b', { messageType: 'Cancel' })]); }, now);
  assert.equal(result.features.length, 1); assert.equal(urls.length, 2);
  assert.equal((await feeds.fetchAlerts(async () => collection([]), now)).features.length, 0);
  await assert.rejects(() => feeds.fetchAlerts(async () => ({ features: [] }), now));
  await assert.rejects(() => feeds.fetchAlerts(async () => ({ ...collection([]), pagination: { next: 'https://example.com' } }), now));
});
test('collapse concurrent loads, cache for 60 seconds, and cool down failures', async () => {
  let calls = 0, clock = now;
  const load = feeds.createAlertLoader(async () => { calls++; return collection([]); }, () => clock);
  await Promise.all([load(), load(), load()]); assert.equal(calls, 1);
  clock += 59999; await load(); assert.equal(calls, 1);
  clock += 1; await load(); assert.equal(calls, 2);
  calls = 0;
  const fail = feeds.createAlertLoader(async () => { calls++; throw Error('offline'); }, () => clock);
  await assert.rejects(fail); await assert.rejects(fail); assert.equal(calls, 1);
});
test('NOAA catalog rejects stale and future-only imagery, exact raster export uses fixed limits', () => {
  const catalog = time => ({ features: [{ attributes: { objectid: 123, idp_validtime: time } }] });
  assert.equal(radar.framesFromCatalog(catalog(now - 60000), now).length, 1);
  assert.throws(() => radar.framesFromCatalog(catalog(now - radar.MAX_AGE - 1), now));
  assert.throws(() => radar.framesFromCatalog(catalog(now + 300000), now));
  const url = new URL(radar.imageUrl({ id: 123 }, [-125, 24, -66, 50]));
  assert.equal(url.searchParams.get('size'), '1536,1024');
  assert.deepEqual(JSON.parse(url.searchParams.get('mosaicRule')).lockRasterIds, [123]);
  assert.equal(url.searchParams.get('imageSR'), '3857');
});
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
test('production pages parse; native renderer exits before making AWS requests', () => {
  for (const file of ['index.html', 'live-alerts.html', 'mosaic-radar-home.html']) {
    for (const m of read(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (m[1].trim()) new vm.Script(m[1], { filename: file });
  }
  const home = read('mosaic-radar-home.html');
  const native = [...home.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('const MANIFEST_URL'))[1];
  vm.runInNewContext(native, { window: { ZWX_PUBLIC_MRMS: true } });
  vm.runInNewContext(read('mapbox-token.js'), { window: { ZWX_PUBLIC_MRMS: true, location: { pathname: '/mosaic-radar-home.html' } } });
  vm.runInNewContext(read('scripts/radar/nexrad-main-live-overlay.js'), {});
  assert(!read('live-alerts.html').includes('new WebSocket'));
  assert(!read('index.html').includes('fetchHomepageLiveAlertFeatures'));
});
test('production alerts replace cancelled products, accept zero alerts, and label refresh failure', async () => {
  const html = read('live-alerts.html');
  const code = html.slice(html.indexOf('    let currentAlertLoad ='), html.indexOf('    const detailShareFeedback ='));
  let result = { ...collection([feature('a')]), verifiedAt: now }, connection;
  const ctx = vm.createContext({ Date: class extends Date { static now() { return now; } }, LiveWeatherFeeds: { loadAlerts: async () => result },
    liveFeatures: [], locationAlertFeatures: null, lastUpdatedEl: {}, normalizeFeature: x => x, isExpired: f => !feeds.isCurrent(f, now), setConnection: (s, text) => { connection = [s, text]; },
    applyAlertDeepLink: () => true, render: () => {}, document: { hidden: false, addEventListener() {} }, setInterval() {}, console: { warn() {} } });
  vm.runInContext(code, ctx); await ctx.loadCurrentAlerts(); assert.equal(ctx.liveFeatures.length, 1);
  result = { ...collection([]), verifiedAt: now }; await ctx.loadCurrentAlerts(); assert.equal(ctx.liveFeatures.length, 0);
  ctx.LiveWeatherFeeds.loadAlerts = async () => { throw Error('offline'); };
  ctx.refreshInBackground(); await new Promise(resolve => setImmediate(resolve)); assert.equal(connection[0], 'offline');
});
test('radar runtime renders a locked NOAA image, supports history, and hides stale imagery', async () => {
  let clock = now, imageRequests = 0;
  const els = new Map(), events = {}, intervals = [], sources = new Map(), layers = new Map();
  const el = id => { if (!els.has(id)) els.set(id, { textContent: '', style: {}, setAttribute() {} }); return els.get(id); };
  const document = { hidden: false, body: { appendChild() {} }, getElementById: el, querySelector: el, createElement: el, addEventListener() {} };
  const map = { addControl() {}, on(name, callback) { events[name] = callback; }, getBounds: () => ({ getWest: () => -125, getSouth: () => 24, getEast: () => -66, getNorth: () => 50 }),
    getSource: id => sources.get(id), getLayer: id => layers.get(id), getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
    addSource(id, source) { sources.set(id, { ...source, updateImage(next) { Object.assign(this, next); } }); },
    addLayer(layer) { layers.set(layer.id, layer); }, removeLayer(id) { layers.delete(id); }, removeSource(id) { sources.delete(id); } };
  const ctx = vm.createContext({ window: {}, document, Date: class extends Date { static now() { return clock; } }, URLSearchParams, URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} },
    mapboxgl: { Map: function () { return map; }, NavigationControl: function () {} }, Image: class { async decode() {} }, AbortSignal,
    setInterval(fn) { intervals.push(fn); }, setTimeout() {}, clearTimeout() {},
    fetch: async url => url.includes('/query?') ? { ok: true, json: async () => ({ features: [0, 1].map(i => ({ attributes: { objectid: i + 100, idp_validtime: now - (i + 1) * 60000 } })) }) } :
      (imageRequests++, { ok: true, headers: { get: () => 'image/png' }, blob: async () => ({}) }) });
  vm.runInContext(read('scripts/radar/public-mrms.js'), ctx);
  events.load(); await new Promise(resolve => setImmediate(resolve));
  assert(layers.has('public-mrms')); assert.equal(imageRequests, 1);
  assert.match(el('frameAge').textContent, /latest available/);
  el('prevFrame').onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.match(el('frameAge').textContent, /history/); assert.equal(imageRequests, 2);
  el('nextFrame').onclick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(imageRequests, 2, 'cached frame avoids another export');
  clock += 21 * 60000; intervals[1](); assert(!layers.has('public-mrms')); assert.match(el('publicRadarStatus').textContent, /hidden/);
});
