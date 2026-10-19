const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../scripts/homepage-newsroom.js');
const now = Date.parse('2026-10-19T00:00:00Z');
const location = data.DEFAULT_LOCATION;
const forecast = (days,source='NWS') => ({days,source,issuedAt:new Date(now-3600000).toISOString()});
const days = [
  {date:'2026-10-19',high:64,low:39,pop:0,wind:8},
  {date:'2026-10-20',high:59,low:35,pop:30,wind:12},
  {date:'2026-10-21',high:60,low:37,pop:10,wind:10}
];
test('no freeze becomes the coldest low with exact coverage, not an empty tile',()=>{
  const view=data.buildStats(forecast(days),null,null,location,now);
  assert.equal(view.stats[1].label,'Coldest forecast low');
  assert.equal(view.stats[1].value,'35°');
  assert.match(view.stats[1].note,/No freeze.*2026-10-21/);
});
test('a freeze is shown only inside the supplied forecast window',()=>{
  const view=data.buildStats(forecast([{...days[0],low:29}]),null,null,location,now);
  assert.equal(view.stats[1].label,'Next freeze');
  assert.match(view.stats[1].note,/29°/);
});
test('nulls stay missing and are never converted to 0 or 32 degrees',()=>{
  assert.equal(data.num(null),null);
  assert.equal(data.quantity({value:null,unitCode:'wmoUnit:degC'},'temp'),null);
  assert.equal(data.normalizeObservation({properties:{timestamp:new Date(now).toISOString(),temperature:{value:null},windSpeed:{value:null}}}).temp,null);
  const view=data.buildStats(forecast(days.map(d=>({...d,low:null,pop:null,wind:null}))),null,null,location,now);
  assert.ok(view.stats.every(s=>s.value!==null));
  assert.ok(!view.stats.some(s=>s.label==='Next freeze'));
});
test('snow and precipitation require complete aligned model periods',()=>{
  const model=forecast(days.map(d=>({...d,snow:0,precip:0})),'Open-Meteo model');
  let view=data.buildStats(forecast(days),model,null,location,now);
  assert.equal(view.stats[3].value,'0.0 in');
  assert.equal(view.stats[5].value,'0.00 in');
  model.days[1].precip=null;model.days[1].snow=null;
  view=data.buildStats(forecast(days),model,null,location,now);
  assert.equal(view.stats[3].label,'Peak precipitation chance');
  assert.equal(view.stats[5].value,'30%');
});
test('snowfall honors the API unit metadata while precipitation remains inches',()=>{
  const inch=data.normalizeModel({daily_units:{snowfall_sum:'inch'},daily:{time:['2026-10-19'],snowfall_sum:[1]}});
  const cm=data.normalizeModel({daily_units:{snowfall_sum:'cm'},daily:{time:['2026-10-19'],snowfall_sum:[2.54]}});
  assert.equal(inch.days[0].snow,1);assert.equal(cm.days[0].snow,1);
  const model=forecast(days.map(d=>({...d,snow:1,precip:1})),'Open-Meteo model');
  const view=data.buildStats(forecast(days),model,null,location,now);
  assert.equal(view.stats[3].value,'3.0 in');assert.equal(view.stats[5].value,'3.00 in');
});
test('stale primary forecast yields to a fresh secondary source',()=>{
  const old={...forecast(days),issuedAt:new Date(now-24*3600000).toISOString()};
  const model=forecast(days,'Open-Meteo model');
  assert.equal(data.chooseForecast(old,model,now),model);
  assert.equal(data.chooseForecast(old,null,now),null);
});
test('a complete feed failure retains honestly labeled location information',()=>{
  const view=data.buildStats(null,null,null,location,now);
  assert.ok(view.stats.length>=4);assert.ok(view.stats.every(s=>s.value));
  assert.equal(view.stats[0].value,'Greensboro, NC');
  assert.match(view.note,/reconnect/);
});
test('partial NWS day omits a missing daytime high and discards expired periods',()=>{
  const payload={properties:{updateTime:new Date(now).toISOString(),periods:[
    {startTime:'2026-10-18T18:00:00-04:00',endTime:'2026-10-18T19:00:00-04:00',temperature:70,isDaytime:true},
    {startTime:'2026-10-18T20:00:00-04:00',endTime:'2026-10-19T06:00:00-04:00',temperature:0,temperatureUnit:'C',isDaytime:false,name:'Tonight',probabilityOfPrecipitation:{value:null},windSpeed:'5 to 15 mph'}
  ]}};
  const result=data.normalizeNwsForecast(payload,location.timeZone,now);
  assert.equal(result.days[0].high,null);assert.equal(result.days[0].low,32);assert.equal(result.days[0].wind,15);assert.equal(result.days[0].pop,null);
});
test('unit conversions distinguish metric station winds',()=>{
  assert.ok(Math.abs(data.quantity({value:16.09344,unitCode:'wmoUnit:km_h-1'},'wind')-10)<0.001);
  assert.equal(data.quantity({value:0,unitCode:'wmoUnit:degC'},'temp'),32);
});
test('location changes do not reuse another city’s cache and seasons use local dates',()=>{
  assert.equal(data.sameLocation(location,{...location,latitude:40}),false);
  assert.equal(data.sameLocation(location,{...location}),true);
  assert.equal(data.coldSeason(Date.parse('2026-10-01T01:00:00Z'),'America/New_York'),false);
  assert.equal(data.coldSeason(Date.parse('2026-10-01T05:00:00Z'),'America/New_York'),true);
});
