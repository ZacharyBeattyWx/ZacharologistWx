const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || `${__dirname}/weather-viewer.html`, 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
const pause = Number(html.match(/SAT_END_PAUSE_MS=(\d+)/)[1]);
assert.equal(pause, 1000);
function fn(name, async = false) {
  const start = html.indexOf(`    ${async ? 'async ' : ''}function ${name}(`);
  const end = html.indexOf('\n    ', start + 1);
  // Function bodies end at four-space indentation; inner statements use six or more.
  const closing = html.indexOf('\n    }', end);
  return html.slice(start, closing + 6);
}
function setupMeso(index = 0, speed = 250) {
  let callback;
  const rendered = [];
  const scope = {
    SAT_END_PAUSE_MS: pause, satTimer: 0, satPlayPreparing: false,
    satPlayGateToken: 0, satWarmGeneration: 1, satContext: { mode: 'mesoscale' },
    satFrames: [{url:'first'}, {url:'newest'}], satFrameIndex: index,
    document: { hidden: false }, satPlay: {}, satSpeed: { value: String(speed) },
    mesoscaleImages: new Map([['first', {}], ['newest', {}]]),
    warmMesoscaleFrames: async () => {},
    renderMesoscaleFrame(next) { rendered.push(next); scope.satFrameIndex = next; },
    requestAnimationFrame(fn) { callback = fn; return 1; },
    stopSatellitePlayback() { scope.satTimer = 0; scope.satPlayPreparing = false; scope.satPlayGateToken++; }
  };
  vm.createContext(scope);
  vm.runInContext(fn('startMesoscalePlayback', true), scope);
  return { scope, rendered, tick: now => callback(now) };
}
(async () => {
  for (const speed of [100,250,500]) {
    const test = setupMeso(0, speed);
    await test.scope.startMesoscalePlayback();
    test.tick(10);
    assert.deepEqual(test.rendered, [1]);
    test.tick(10 + pause - 1);
    assert.equal(test.scope.satFrameIndex, 1, 'Newest frame stays visible until the hold expires');
    test.tick(10 + pause);
    assert.deepEqual(test.rendered, [1,0]);
    test.tick(10 + pause + speed - 1);
    assert.equal(test.scope.satFrameIndex, 0, 'Regular cadence is preserved');
    test.tick(10 + pause + speed);
    assert.equal(test.scope.satFrameIndex, 1);
    test.scope.stopSatellitePlayback();
    test.tick(10000);
    assert.equal(test.scope.satFrameIndex, 1, 'Stopping during the hold cancels wraparound');
    const resumed = setupMeso(1, speed);
    await resumed.scope.startMesoscalePlayback();
    resumed.tick(100);
    assert.equal(resumed.rendered.length, 0, 'Starting on newest also gets a hold');
    resumed.tick(100 + pause - 1);
    assert.equal(resumed.scope.satFrameIndex, 1);
    resumed.tick(100 + pause);
    assert.deepEqual(resumed.rendered, [0]);
    const hidden = setupMeso();
    await hidden.scope.startMesoscalePlayback();
    hidden.tick(1);
    hidden.scope.document.hidden = true;
    hidden.tick(5000);
    assert.equal(hidden.scope.satTimer, 0);
    assert.deepEqual(hidden.rendered, [1]);
    const context = {}, updates = [];
    const normal = {
      SAT_END_PAUSE_MS: pause, SAT_CROSSFADE_MAX_MS: 60, SAT_CROSSFADE_FRACTION: .35,
      satFrames: [{},{}], satPlayGateToken: 1, satWarmGeneration: 1,
      satContext: context, activeProduct: 'satellite',
      drawSatelliteTransition() {}, queueSatellitePlaybackFrame() {},
      updateSatellitePlaybackFrame(index) { updates.push(index); }
    };
    const state = { token:1,generation:1,context,fromIndex:0,toIndex:1,stepMs:speed,startedAt:0,nextDeadline:speed };
    normal.satPlaybackState = state;
    vm.createContext(normal);
    vm.runInContext(fn('runSatellitePlaybackFrame'), normal);
    normal.runSatellitePlaybackFrame(state, speed);
    assert.deepEqual(updates, [1]);
    assert.equal(state.nextDeadline, speed + pause);
    normal.runSatellitePlaybackFrame(state, speed + pause - 1);
    assert.deepEqual(updates, [1]);
    normal.runSatellitePlaybackFrame(state, speed + pause);
    assert.deepEqual(updates, [1,0]);
    assert.equal(state.nextDeadline, speed + pause + speed);
  }
  assert.match(fn('startSatellitePlayback', true), /satFrameIndex>=satFrames.length-1\s*\?SAT_END_PAUSE_MS/);
  console.log('PASS: one-second final-frame hold for regular and mesoscale loops, fast/normal/slow cadence, starting on newest, cancellation and hidden-tab pause.');
})().catch(error => { console.error(error); process.exitCode = 1; });
