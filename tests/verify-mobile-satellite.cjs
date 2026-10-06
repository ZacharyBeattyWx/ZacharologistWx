const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || `${__dirname}/../weather-viewer.html`, 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
const styles = {};
const media = { hidden: false, width: 1200, height: 800, style: {} };
const scope = {
  activeProduct: 'satellite', currentSectorSpec: () => ({}),
  window: { matchMedia: () => ({ matches: true }) },
  satelliteCanvas: media, satelliteImage: { style: {} },
  satelliteStage: { getBoundingClientRect: () => ({ width: 390, height: 700 }),
    style: { setProperty: (key, value) => { styles[key] = value; } },
    classList: { add() {}, remove() {} } },
  renderSatelliteBoundaries() {},
};
vm.createContext(scope);
vm.runInContext(html.slice(html.indexOf('    let satPanX='), html.indexOf('    let lightningSeenLatestMs=')), scope);
assert.ok(scope.satellitePanBounds().overflowX > 0, 'Zoom permits horizontal swipes');
assert.ok(scope.satellitePanBounds().overflowY > 0, 'Zoom permits vertical swipes');
const event = (x, y) => ({ pointerId: 1, button: 0, clientX: x, clientY: y,
  target: { closest: () => null }, preventDefault() {} });
scope.beginSatellitePan(event(200, 400));
scope.moveSatellitePan(event(200, 10000));
assert.equal(vm.runInContext('satPanY', scope), 0, 'Top edge is reachable');
scope.moveSatellitePan(event(200, -10000));
assert.equal(vm.runInContext('satPanY', scope), 100, 'Bottom edge is reachable');
scope.endSatellitePan(event(200, -10000));
vm.runInContext('satMobileFit=true; resetSatellitePan();', scope);
assert.equal(scope.satellitePanBounds().overflowX, 0);
assert.equal(scope.satellitePanBounds().overflowY, 0);
assert.ok(parseFloat(styles['--sat-media-width']) <= 390);
assert.ok(parseFloat(styles['--sat-media-height']) <= 530);
assert.equal(scope.mobileSatellitePanEnabled(), false, 'Fit mode does not capture gestures');
vm.runInContext('satMobileFit=false;', scope);
scope.beginSatellitePan({ ...event(0, 0), target: { closest: () => ({}) } });
assert.equal(vm.runInContext('satPanPointerId', scope), null, 'Controls do not start a swipe');
scope.currentSectorSpec = () => ({ mesoscale: true });
assert.equal(scope.mobileSatellitePanEnabled(), false, 'Existing fitted mesoscale geometry is preserved');
console.log('PASS: two-axis swiping, top/bottom limits, full-sector fit, control gesture isolation, mesoscale fit, JavaScript syntax.');
