/* NOAA's rendered MRMS fallback. The baked native renderer remains in the page,
   dormant while its AWS publisher/delivery is shut down. */
(function (root) {
  'use strict';
  const SERVICE = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer';
  const MAX_AGE = 20 * 60000;
  function catalogUrl() {
    return SERVICE + '/query?' + new URLSearchParams({ f: 'json', where: "idp_subset = 'CONUS' AND category = 1",
      outFields: 'objectid,idp_validtime', orderByFields: 'idp_validtime DESC', resultRecordCount: '6', returnGeometry: 'false' });
  }
  function framesFromCatalog(data, now = Date.now()) {
    if (data.error || !Array.isArray(data.features)) throw new Error('NOAA radar catalog unavailable');
    const frames = data.features.map(f => ({ id: f.attributes.objectid, time: f.attributes.idp_validtime }))
      .filter(f => Number.isInteger(f.id) && Number.isFinite(f.time) && f.time <= now + 60000 && now - f.time < 60 * 60000)
      .sort((a, b) => a.time - b.time);
    if (!frames.length || now - frames[frames.length - 1].time > MAX_AGE) throw new Error('NOAA radar is delayed (over 20 minutes)');
    return frames;
  }
  function imageUrl(frame, bounds) {
    return SERVICE + '/exportImage?' + new URLSearchParams({ f: 'image', bbox: bounds.join(','), bboxSR: '4326', imageSR: '3857',
      size: '1536,1024', format: 'png32', transparent: 'true', adjustAspectRatio: 'false', interpolation: 'RSP_NearestNeighbor',
      mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [frame.id] }) });
  }
  const api = { catalogUrl, framesFromCatalog, imageUrl, MAX_AGE };
  if (typeof module !== 'undefined') { module.exports = api; return; }
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;top:10px;left:10px;z-index:30;max-width:calc(100% - 85px);background:#07111feb;color:#fff;padding:9px 12px;border-radius:8px;font:12px Arial;line-height:1.5';
  badge.setAttribute('role', 'status');
  badge.innerHTML = 'NOAA MRMS · temporary public-service view<br><span id="publicRadarStatus">Checking observation time…</span><br><small>Native detail paused · NOAA colors · <a style="color:#67e8f9" href="https://radar.weather.gov/" target="_blank" rel="noopener">Official radar ↗</a></small>';
  document.body.appendChild(badge);
  document.querySelector('.legend').hidden = true;
  document.querySelector('.timeline-labels').innerHTML = '<span>Recent observations</span><span>Latest available</span>';
  const status = document.getElementById('publicRadarStatus');
  const slider = document.getElementById('frameSlider');
  const play = document.getElementById('playPause');
  const frameTime = document.getElementById('frameTime');
  const ageLabel = document.getElementById('frameAge');
  mapboxgl.accessToken = root.MAPBOX_PUBLIC_TOKEN;
  const map = new mapboxgl.Map({ container: 'map', style: 'mapbox://styles/zacharybeattywx/cmpdipwzh00fq01sccdj806xy',
    center: [-96.5, 38.4], zoom: 3.35, minZoom: 2, maxZoom: 10, projection: 'mercator' });
  map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
  let frames = [], index = 0, displayed = null, latestVerified = 0, busy = false, playing = false, generation = 0, timer, moveTimer;
  let exports = [], lastCatalog = -Infinity;
  const cache = new Map();
  function stop() { playing = false; clearTimeout(timer); play.textContent = '▶ Play'; }
  function removeImage() {
    if (map.getLayer('public-mrms')) map.removeLayer('public-mrms');
    if (map.getSource('public-mrms')) map.removeSource('public-mrms');
    displayed = null;
  }
  function updateAge() {
    if (!displayed) return;
    const minutes = Math.max(0, Math.floor((Date.now() - displayed.time) / 60000));
    ageLabel.textContent = `${minutes} min old${displayed.id === frames[frames.length - 1]?.id ? ' · latest available' : ' · history'}`;
    // History may be intentionally older. Remove everything when the newest feed
    // observation is stale, regardless of refresh failures or playback state.
    if (Date.now() - latestVerified > MAX_AGE) {
      stop(); removeImage(); status.textContent = 'Radar delayed — imagery hidden; use official radar.';
    }
  }
  async function show(next) {
    if (busy || !frames.length || document.hidden) return;
    index = (next + frames.length) % frames.length;
    const frame = frames[index];
    if (Date.now() - latestVerified > MAX_AGE) { updateAge(); return; }
    const b = map.getBounds();
    const bounds = [Math.max(-130, b.getWest()), Math.max(20, b.getSouth()), Math.min(-60, b.getEast()), Math.min(55, b.getNorth())];
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) { removeImage(); status.textContent = 'Pan to the continental United States for MRMS.'; return; }
    const rounded = bounds.map(x => Math.round(x * 100) / 100);
    const url = imageUrl(frame, rounded);
    const requestGeneration = generation;
    busy = true;
    try {
      let blobUrl = cache.get(url);
      if (!blobUrl) {
        exports = exports.filter(t => Date.now() - t < 60000);
        if (exports.length >= 12) throw new Error('Radar request limit reached; updates resume next minute');
        exports.push(Date.now());
        const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'force-cache' });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('NOAA radar image unavailable');
        blobUrl = URL.createObjectURL(await response.blob());
        // Decode before swapping: an HTTP 200 error document must not masquerade as radar.
        const image = new Image(); image.src = blobUrl;
        try { await image.decode(); } catch (error) { URL.revokeObjectURL(blobUrl); throw error; }
        cache.set(url, blobUrl);
      }
      while (cache.size > 8) { const key = cache.keys().next().value; URL.revokeObjectURL(cache.get(key)); cache.delete(key); }
      if (requestGeneration !== generation || document.hidden) return;
      const [west, south, east, north] = rounded;
      const coordinates = [[west, north], [east, north], [east, south], [west, south]];
      const source = map.getSource('public-mrms');
      if (source) source.updateImage({ url: blobUrl, coordinates });
      else {
        map.addSource('public-mrms', { type: 'image', url: blobUrl, coordinates });
        const before = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
        map.addLayer({ id: 'public-mrms', type: 'raster', source: 'public-mrms', paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, before);
      }
      displayed = frame;
      slider.value = String(index);
      frameTime.textContent = new Date(frame.time).toLocaleString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      status.textContent = 'NOAA observation loaded · refresh every 2 min';
      updateAge();
    } catch (error) {
      stop(); status.textContent = `${error.message}. ${displayed ? 'Previous observation remains; check its age.' : 'No radar image loaded.'}`;
    } finally { busy = false; }
  }
  async function refresh() {
    if (document.hidden || Date.now() - lastCatalog < 120000) return;
    lastCatalog = Date.now();
    try {
      const response = await fetch(catalogUrl(), { signal: AbortSignal.timeout(12000), cache: 'no-cache' });
      if (!response.ok) throw new Error('NOAA radar catalog unavailable');
      frames = framesFromCatalog(await response.json());
      latestVerified = frames[frames.length - 1].time;
      slider.max = String(frames.length - 1);
      if (!playing) await show(frames.length - 1);
    } catch (error) { stop(); status.textContent = error.message + ' — check observation age or use official radar.'; updateAge(); }
  }
  async function tick() {
    if (!playing) return;
    await show(index + 1);
    if (playing) timer = setTimeout(tick, index === frames.length - 1 ? 2000 : 1000);
  }
  play.onclick = () => { if (playing) stop(); else if (frames.length > 1) { playing = true; play.textContent = '❚❚ Pause'; tick(); } };
  document.getElementById('prevFrame').onclick = () => { stop(); show(index - 1); };
  document.getElementById('nextFrame').onclick = () => { stop(); show(index + 1); };
  slider.oninput = () => { stop(); show(Number(slider.value)); };
  document.getElementById('speedSelect').hidden = true;
  map.on('moveend', () => { generation++; stop(); clearTimeout(moveTimer); moveTimer = setTimeout(() => show(index), 1000); });
  map.on('load', () => { refresh(); setInterval(refresh, 120000); setInterval(updateAge, 15000); });
  map.on('error', () => { status.textContent = 'Map or radar layer error — use official radar if imagery is missing.'; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { generation++; stop(); }
    else { updateAge(); refresh().then(() => show(index)); }
  });
})(typeof window === 'undefined' ? globalThis : window);
