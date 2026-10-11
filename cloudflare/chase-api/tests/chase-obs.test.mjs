import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGpsSample, pointInNwsGeometry, selectPointAlerts, createObsSnapshot } from '../src/chase-obs.js';

const now = Date.parse('2026-10-11T18:00:00.000Z');

test('rejects old, future, or invalid GPS fixes', () => {
  assert.match(validateGpsSample({ lat: 35, lon: -80, updatedAt: new Date(now-70000).toISOString() },now).error,/stale/);
  assert.ok(validateGpsSample({ lat: 100, lon: -80, updatedAt: new Date(now).toISOString() },now).error);
  assert.ok(validateGpsSample({ lat: 0, lon: 0, updatedAt: new Date(now+40000).toISOString() },now).error);
  assert.equal(validateGpsSample({ lat: 0, lon: 0, updatedAt: new Date(now).toISOString() },now).value.lat, 0);
});

const polygon = { type: 'Polygon', coordinates: [
  [[-81,34],[-79,34],[-79,36],[-81,36],[-81,34]],
  [[-80.1,34.9],[-79.9,34.9],[-79.9,35.1],[-80.1,35.1],[-80.1,34.9]]
] };

test('warning polygon inclusion respects holes', () => {
  assert.equal(pointInNwsGeometry(35,-80.8,polygon),true);
  assert.equal(pointInNwsGeometry(35,-80,polygon),false);
  assert.equal(pointInNwsGeometry(36.8,-80,polygon),false);
  assert.equal(pointInNwsGeometry(35,-80.8,{type:'MultiPolygon',coordinates:[polygon.coordinates]}),true);
});

test('deduplicates point alerts, excludes expired warnings, prioritizes tornado', () => {
  const features = [
    {id:'watch',geometry:null,properties:{event:'Tornado Watch',expires:new Date(now+600000).toISOString()}},
    {id:'warn',geometry:{type:'Polygon',coordinates:[polygon.coordinates[0]]},properties:{event:'Tornado Warning',expires:new Date(now+600000).toISOString()}},
    {id:'warn',geometry:null,properties:{event:'Tornado Warning'}},
    {id:'old',geometry:null,properties:{event:'Severe Thunderstorm Warning',expires:new Date(now-1).toISOString()}}
  ];
  assert.deepEqual(selectPointAlerts({features},35,-80.8,now).map(item=>item.event), ['Tornado Warning','Tornado Watch']);
});

test('privacy and alert failure states never claim no warnings on error', async () => {
  const row={chase_lat:35.12345,chase_lon:-80.54321,chase_location_updated:new Date(now).toISOString(),chase_map_display:0};
  const failure=await createObsSnapshot(row,{now,fetcher:async()=>{throw new Error('NWS unavailable')}});
  assert.equal(failure.location.label,'LOCATION HIDDEN');
  assert.equal(failure.alerts.state,'unavailable');
  assert.ok(!JSON.stringify(failure).includes('35.12345'));
  const stale=await createObsSnapshot({...row,chase_location_updated:new Date(now-120000).toISOString()},{now});
  assert.equal(stale.alerts.state,'unknown');
});

test('a verified empty NWS response can indicate no local warnings', async () => {
  const row={chase_lat:35.2,chase_lon:-80.5,chase_location_updated:new Date(now).toISOString(),chase_map_display:1};
  const result=await createObsSnapshot(row,{now,fetcher:async()=>({ok:true,json:async()=>({features:[]})})});
  assert.equal(result.alerts.state,'live');
  assert.equal(result.alerts.items.length,0);
  assert.equal(result.location.label,'NEAR 35.20, -80.50');
});
