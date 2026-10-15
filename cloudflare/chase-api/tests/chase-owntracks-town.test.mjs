import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnTracksLocation } from '../src/chase-owntracks.js';
import { townFromMapbox, townFromNws, reverseTownLabel } from '../src/chase-town.js';
import { createObsSnapshot } from '../src/chase-obs.js';

const now = Date.parse('2026-10-15T18:00:00Z');

test('OwnTracks converts timestamps, speed and course for the chase database', () => {
  const result = parseOwnTracksLocation({
    _type: 'location', lat: 36.21, lon: -79.71, acc: 6,
    vel: 72, cog: 270, tst: Math.floor(now / 1000), tid: 'ZW'
  }, now);
  assert.equal(result.value.speed, 20);
  assert.equal(result.value.heading, 270);
  assert.equal(result.value.accuracy, 6);
  assert.equal(result.value.updatedAt, '2026-10-15T18:00:00.000Z');
});

test('OwnTracks ignores queued stale fixes, invalid coordinates and other message types', () => {
  assert.equal(parseOwnTracksLocation({_type:'location',lat:36,lon:-79,tst:Math.floor(now / 1000)-100},now).ignored,true);
  assert.equal(parseOwnTracksLocation({_type:'transition',event:'enter'},now).ignored,true);
  assert.ok(parseOwnTracksLocation({_type:'location',lat:100,lon:-79,tst:Math.floor(now/1000)},now).error);
  assert.ok(parseOwnTracksLocation({_type:'location',lat:36,lon:-79,tst:Math.floor(now/1000)+60},now).error);
});

test('Mapbox prefers locality over place and formats a recognizable state', () => {
  const data={features:[
    {properties:{feature_type:'place',name:'Greensboro',context:{region:{region_code:'US-NC'}}}},
    {properties:{feature_type:'locality',name:'Browns Summit',context:{region:{region_code:'US-NC'}}}}
  ]};
  assert.equal(townFromMapbox(data),'NEAR BROWNS SUMMIT, NC');
});

test('NWS nearest city yields area label without exposing coordinates', () => {
  assert.equal(townFromNws({properties:{relativeLocation:{properties:{city:'Greensboro',state:'NC'}}}}),'NEAR GREENSBORO, NC');
});

test('reverse geocoding uses NWS without billing token', async () => {
  const calls=[];
  const result=await reverseTownLabel(36.2,-79.7,{fetcher:async(url)=>{
    calls.push(url);
    return {ok:true,json:async()=>({properties:{relativeLocation:{properties:{city:'Greensboro',state:'NC'}}}})};
  }});
  assert.equal(result,'NEAR GREENSBORO, NC');
  assert.equal(calls.length,1);
  assert.ok(calls[0].startsWith('https://api.weather.gov/points/'));
});

test('OBS exposes a town label while respecting hidden/stale privacy and NWS failures', async () => {
  const row={chase_lat:36.21,chase_lon:-79.71,chase_map_display:1,chase_location_updated:new Date(now).toISOString()};
  const fetcher=async()=>({ok:true,json:async()=>({features:[]})});
  const result=await createObsSnapshot(row,{now,fetcher,resolveTown:async()=> 'NEAR BROWNS SUMMIT, NC'});
  assert.equal(result.location.label,'NEAR BROWNS SUMMIT, NC');
  assert.equal(result.alerts.state,'live');
  assert.ok(!JSON.stringify(result).includes('36.21'));
  const hidden=await createObsSnapshot({...row,chase_map_display:0},{now,fetcher,resolveTown:async()=>{throw Error('should not geocode')}});
  assert.equal(hidden.location.label,'LOCATION HIDDEN');
  const stale=await createObsSnapshot({...row,chase_location_updated:new Date(now-120000).toISOString()},{now,resolveTown:async()=>{throw Error('should not geocode')}});
  assert.equal(stale.location.label,'GPS LOCATION STALE');
});
