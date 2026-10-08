const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(`${__dirname}/weather-viewer.html`, 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
function fn(name) {
  const start = html.indexOf(`    function ${name}(`);
  const end = html.indexOf('\n    function ', start + 1);
  return html.slice(start, end);
}
const scope = { TRUECOLOR_BASE: 'https://example.test/satellite', satPlatform: 'East' };
vm.createContext(scope);
vm.runInContext(fn('mercator') + fn('bboxContains'), scope);
const start = html.indexOf('    const SAT_SECTORS=');
const end = html.indexOf('    const tabs=', start);
vm.runInContext(html.slice(start, end) + '\nthis.catalog={SAT_SECTORS,LOCALIZED_SECTORS,SAT_PUBLISHED_SECTORS,SAT_SECTOR_ALIASES,COD_CONUS_LOCAL_CENTERS,COD_CONUS_SUBREGIONAL_CENTERS};', scope);
vm.runInContext(fn('allSatelliteSectors') + fn('sectorGroupForId') + fn('trueColorManifestUrls') + fn('fitSatelliteBboxToStage'), scope);
const { SAT_SECTORS, LOCALIZED_SECTORS, SAT_PUBLISHED_SECTORS, SAT_SECTOR_ALIASES, COD_CONUS_LOCAL_CENTERS, COD_CONUS_SUBREGIONAL_CENTERS } = scope.catalog;
const ids = new Set();
let fallback = [];
for (const platform of ['East', 'West']) {
  scope.satPlatform = platform;
  const sectors = scope.allSatelliteSectors(platform);
  assert.equal(new Set(sectors.map(s => s.id)).size, sectors.length);
  const regional = platform === 'East' ? [-126,22,-58,53] : [-134,20,-101,53];
  for (const item of sectors.filter(s => s.clientCrop)) {
    assert.ok(scope.bboxContains(regional, item.bbox), `${platform} ${item.id} exceeds regional coverage`);
    assert.equal(scope.sectorGroupForId(item.id), item.group);
    assert.equal(item.fixedFootprint, true);
    const projected = [...scope.mercator(item.bbox[0], item.bbox[1]), ...scope.mercator(item.bbox[2], item.bbox[3])];
    assert.ok(Math.abs((projected[2]-projected[0])/(projected[3]-projected[1])-16/9) < 1e-10 || item.id === 'loc-atl');
    assert.equal(JSON.stringify(scope.fitSatelliteBboxToStage(projected, item)), JSON.stringify(projected));
    const urls = scope.trueColorManifestUrls(platform, item);
    assert.ok(urls.every(url => !url.includes('/sectors/loc-') && !url.includes('/sectors/sub-')));
    if (urls.length === 1) fallback.push(`${platform}/${item.label}`);
    if (item.codId) {
      ids.add(item.codId);
      const center = [...COD_CONUS_LOCAL_CENTERS, ...COD_CONUS_SUBREGIONAL_CENTERS].find(row => row[0] === item.codId);
      assert.ok(scope.bboxContains(item.bbox, [center[2],center[3],center[2],center[3]]), `${item.id} lost its reference center`);
      const parents = SAT_PUBLISHED_SECTORS[platform].filter(parent => !['global','CONUS','PACUS','gwas'].includes(parent.id) && scope.bboxContains(parent.bbox, item.bbox));
      assert.ok(parents.length > 0);
      assert.equal(urls.length, parents.length + 1);
    }
  }
  assert.equal(SAT_PUBLISHED_SECTORS[platform].filter(s => !['global','CONUS','PACUS','gwas'].includes(s.id)).length, platform === 'East' ? 9 : 2);
}
for (const [id] of [...COD_CONUS_LOCAL_CENTERS, ...COD_CONUS_SUBREGIONAL_CENTERS]) assert.ok(ids.has(id), `Missing ${id} on both platforms`);
const ga = LOCALIZED_SECTORS.East.find(s => s.codId === 'Georgia');
const broadGa = SAT_SECTORS.East.find(s => s.id === 'loc-atl');
assert.ok(scope.bboxContains(broadGa.bbox, ga.bbox));
assert.ok((ga.bbox[2]-ga.bbox[0])*(ga.bbox[3]-ga.bbox[1]) < 0.5*(broadGa.bbox[2]-broadGa.bbox[0])*(broadGa.bbox[3]-broadGa.bbox[1]));
assert.match(html, /const savedSector=SAT_SECTOR_ALIASES\[saved.satSector\]\|\|saved.satSector/);
assert.equal(fallback.length, 0, 'Every catalog crop must have a real high-resolution parent');
for (const [platform, legacy] of [['East',['nr','umv','cgl','ne','sr','sp','smv','se','eus','loc-cpl','loc-ntx','loc-hou','loc-chi','loc-ohv','loc-fl','loc-ma','loc-ne']], ['West',['pnw','psw','loc-pdx','loc-nca','loc-cca','loc-sca','loc-dsw']]]) {
  const sectors = scope.allSatelliteSectors(platform);
  for (const id of legacy) assert.ok(sectors.some(s => s.id === SAT_SECTOR_ALIASES[id]), `Lost saved ${platform}/${id}`);
}
console.log(`PASS: ${COD_CONUS_LOCAL_CENTERS.length} localized and ${COD_CONUS_SUBREGIONAL_CENTERS.length} sub-regional CONUS reference choices; syntax, containment, grouping, fixed framing and real manifest URLs.`);
console.log(`Regional fallback crops (${fallback.length}): ${fallback.join(', ')}`);
