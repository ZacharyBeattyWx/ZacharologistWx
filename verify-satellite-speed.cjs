const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || `${__dirname}/weather-viewer.html`, 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
function fn(name) {
  const start = html.indexOf(`    function ${name}(`);
  const end = html.indexOf('\n    }', start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end + 6);
}
const elements = new Map();
const saved = new Map();
const scope = {
  satSpeed:{value:'250'},satPlaybackState:null,satFrames:[{},{},{}],
  activeProduct:'satellite',radarMode:'national',satPlatform:'East',satProduct:'TrueColor',
  satSector:'global',satLoopFrameCount:24,satLoopFrameStride:1,
  SAT_PRODUCTS:{TrueColor:{}},SAT_SECTOR_ALIASES:{},VIEWER_STATE_KEY:'test',
  allSatelliteSectors:()=>[{id:'global'}],performance:{now:()=>1100},
  sessionStorage:{setItem:(key,value)=>saved.set(key,value),getItem:key=>saved.get(key)},
  document:{getElementById(id){if(!elements.has(id))elements.set(id,{});return elements.get(id);},querySelector:()=>({})}
};
vm.createContext(scope);
vm.runInContext(html.match(/    const SAT_SPEED_MIN=.*;/)[0] + fn('setSatellitePlaybackSpeed') + fn('adjustSatellitePlaybackSpeed') + fn('saveViewerState') + fn('restoreViewerState'), scope);
const rate = () => 250 / Number(scope.satSpeed.value);
scope.setSatellitePlaybackSpeed(250);
assert.equal(rate(),1);
assert.equal(elements.get('satSpeedReadout').textContent,'1×');
scope.adjustSatellitePlaybackSpeed(1);
assert.equal(rate(),1.25);
scope.adjustSatellitePlaybackSpeed(-1);
assert.equal(rate(),1);
for(let i=0;i<30;i++)scope.adjustSatellitePlaybackSpeed(-1);
assert.equal(rate(),.25);
assert.equal(elements.get('satSpeedSlower').disabled,true);
assert.equal(elements.get('satSpeedFaster').disabled,false);
for(let i=0;i<30;i++)scope.adjustSatellitePlaybackSpeed(1);
assert.equal(rate(),4);
assert.equal(elements.get('satSpeedFaster').disabled,true);
assert.equal(elements.get('satSpeedSlower').disabled,false);
for(const invalid of [undefined,null,0,-3,NaN,Infinity,'not a speed']) {
  scope.setSatellitePlaybackSpeed(invalid);
  assert.equal(rate(),1);
}
scope.setSatellitePlaybackSpeed(.001);
assert.equal(rate(),4);
scope.setSatellitePlaybackSpeed(100000);
assert.equal(rate(),.25);
// Restore the selected rate without writing preferences during restoration.
scope.setSatellitePlaybackSpeed(250/1.75);
const preferences = saved.get('test');
assert.equal(JSON.parse(preferences).satPlaybackStepMs,250/1.75);
scope.setSatellitePlaybackSpeed(250,false);
scope.restoreViewerState();
assert.equal(rate(),1.75);
assert.equal(saved.get('test'),preferences);
saved.set('test',JSON.stringify({satSector:'global'}));
scope.restoreViewerState();
assert.equal(rate(),1,'Old preferences keep the default speed');
// Running regular loops change cadence in place, not by restarting the player.
const state={fromIndex:0,startedAt:1000,nextDeadline:1250,stepMs:250};
scope.satPlaybackState=state;
scope.setSatellitePlaybackSpeed(250/2);
assert.equal(scope.satPlaybackState,state);
assert.equal(state.stepMs,125);
assert.equal(state.nextDeadline,1125);
scope.setSatellitePlaybackSpeed(250/4);
assert.equal(state.nextDeadline,1100,'An overdue normal-frame deadline may advance on the next tick');
state.fromIndex=2;state.nextDeadline=2000;
scope.setSatellitePlaybackSpeed(250/.5);
assert.equal(state.stepMs,500);
assert.equal(state.nextDeadline,2000,'Speed changes must preserve the newest-frame hold');
assert.match(html, /id="satSpeedSlower"[^>]*title="Slower playback"[^>]*aria-label="Slower playback"/);
assert.match(html, /id="satSpeedFaster"[^>]*title="Faster playback"[^>]*aria-label="Faster playback"/);
assert.match(html, /id="satSpeedReadout" aria-live="polite"/);
assert.match(html, /<input id="satSpeed" type="hidden" value="250">/);
assert.ok(!html.includes('<select id="satSpeed"'));
assert.match(html, /grid-template-columns:44px minmax\(0,1fr\) 44px 132px/);
for(const viewport of [320,375,390,430]) {
  const availablePlayWidth=viewport-16-18-44-44-132;
  assert.ok(availablePlayWidth>=66,'Mobile toolbar reserves space for the play label and 44px speed buttons');
}
console.log('PASS: quarter-speed adjustments, min/max buttons, invalid values, session restore, in-place cadence changes, preserved end hold, accessible controls and mobile layout constraints.');
