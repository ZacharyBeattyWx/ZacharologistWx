(function () {
  'use strict';
  // Read-only public OBS endpoint: NEVER embed Admin or GPS publishing secrets here.
  var API = 'https://zacharologistwx.com/api/chase/obs';
  var POLL_MS = 30000, GPS_FRESH_MS = 90000, RESPONSE_FRESH_MS = 110000;
  var lastData = null, lastRequestFailed = false;
  var el = function (id) { return document.getElementById(id); };
  var set = function (id, value) { var n = el(id); if (n) n.textContent = value; };

  function statusClass(name) {
    var badge = el('v-alert');
    if (!badge) return;
    badge.classList.remove('zwx-tornado', 'zwx-severe', 'zwx-watch', 'zwx-clear', 'zwx-unavailable');
    badge.classList.add(name || 'zwx-unavailable');
  }
  function setOffline(reason) {
    set('v-location', 'LOCATION NOT CONNECTED');
    set('v-alert', 'WARNING STATUS UNKNOWN');
    set('v-headline', reason || 'GPS / NWS FEED NOT CONNECTED');
    set('v-status', 'DATA OFFLINE');
    set('v-gps', 'GPS OFFLINE');
    set('v-alert-status', 'NWS NOT VERIFIED');
    statusClass('zwx-unavailable');
  }
  function liveGps(data) {
    var loc = data && data.location;
    if (!loc || !loc.updatedAt) return false;
    var t = Date.parse(loc.updatedAt);
    return Number.isFinite(t) && Date.now() - t <= GPS_FRESH_MS &&
      Date.now() - t >= -30000 && (loc.state === 'live' || loc.state === 'hidden');
  }
  function render() {
    var data = lastData;
    if (!data || lastRequestFailed) {
      setOffline(lastRequestFailed ? 'CHASE DATA UNAVAILABLE — CHECK GPS AND NWS' : 'CONNECT GPS / NWS TO SHOW CHASE STATUS');
      return;
    }
    var generated = Date.parse(data.generatedAt || '');
    if (!Number.isFinite(generated) || Date.now() - generated > RESPONSE_FRESH_MS) {
      setOffline('CHASE DATA STALE — DO NOT RELY ON THIS WARNING DISPLAY');
      return;
    }
    var location = data.location || {}, alerts = data.alerts || {}, gpsOkay = liveGps(data);
    set('v-location', gpsOkay ? String(location.label || 'LOCATION HIDDEN') :
      location.state === 'stale' ? 'GPS LOCATION STALE' : 'LOCATION NOT CONNECTED');
    set('v-gps', gpsOkay ? (location.state === 'hidden' ? 'GPS LIVE • HIDDEN' : 'GPS LIVE') : 'GPS STALE / OFFLINE');

    if (!gpsOkay) {
      set('v-alert', 'GPS STALE — WARNINGS UNKNOWN');
      set('v-headline', 'GPS POSITION UNAVAILABLE — WARNING STATUS CANNOT BE VERIFIED');
      set('v-status', 'GPS OFFLINE');
      set('v-alert-status', 'POSITION UNKNOWN');
      statusClass('zwx-unavailable');
      return;
    }
    if (alerts.state !== 'live') {
      set('v-alert', alerts.state === 'uncertain' ? 'GPS ACCURACY LOW' : 'NWS DATA UNAVAILABLE');
      set('v-headline', 'WARNING STATUS UNKNOWN — CHECK OFFICIAL NWS ALERTS');
      set('v-status', 'ALERTS NOT VERIFIED');
      set('v-alert-status', alerts.state === 'uncertain' ? 'GPS INACCURATE' : 'NWS NOT VERIFIED');
      statusClass('zwx-unavailable');
      return;
    }
    var items = Array.isArray(alerts.items) ? alerts.items : [];
    if (!items.length) {
      set('v-alert', 'NO ACTIVE WARNINGS');
      set('v-headline', 'NO ACTIVE NWS WARNINGS OR WATCHES AT CURRENT GPS LOCATION');
      set('v-alert-status', 'NO ACTIVE WARNINGS');
      statusClass('zwx-clear');
    } else {
      var primary = items[0], event = String(primary.event || 'ACTIVE NWS ALERT').toUpperCase();
      set('v-alert', event + (items.length > 1 ? ' + ' + (items.length - 1) : ''));
      set('v-alert-status', items.length + (items.length === 1 ? ' ACTIVE ALERT' : ' ACTIVE ALERTS'));
      set('v-headline', String(primary.headline || primary.event || 'NWS WARNING IN EFFECT').slice(0,180));
      statusClass(/TORNADO WARNING/.test(event) ? 'zwx-tornado' :
        /WARNING/.test(event) ? 'zwx-severe' : 'zwx-watch');
    }
    set('v-status', 'NWS CHECKED');
  }

  async function refresh() {
    try {
      var response = await fetch(API, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      if (!data || data.version !== 1) throw new Error('Invalid OBS response');
      lastData = data;
      lastRequestFailed = false;
    } catch (error) {
      console.warn('Zacharologist Wx OBS feed:', error);
      lastRequestFailed = true;
    }
    render();
  }

  function setClock() {
    var node = el('clock');
    if (!node) return;
    try {
      node.textContent = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
      }).format(new Date());
    } catch (_error) { node.textContent = 'LOCAL TIME'; }
  }
  setOffline('CONNECT GPS / NWS TO SHOW CHASE STATUS');
  setClock();
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(render, 5000);
  setInterval(setClock, 1000);
})();
