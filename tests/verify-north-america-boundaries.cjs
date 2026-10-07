const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=process.argv[2]||path.resolve(__dirname,'..');
const supplement=JSON.parse(fs.readFileSync(path.join(root,'assets/satellite-canada-mexico-boundaries.geojson'),'utf8'));
const counts={CAN:0,MEX:0};
const codes=new Set();
for(const feature of supplement.features){
  counts[feature.properties.country]++;
  assert(feature.properties.name);
  assert(!codes.has(feature.properties.abbr));codes.add(feature.properties.abbr);
  const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
  assert(['Polygon','MultiPolygon'].includes(feature.geometry.type));
  for(const polygon of polygons)for(const ring of polygon){
    assert(ring.length>=4);assert.deepEqual(ring[0],ring.at(-1));
    for(const [lon,lat]of ring){assert(Number.isFinite(lon)&&Math.abs(lon)<=180);assert(Number.isFinite(lat)&&Math.abs(lat)<85);}
  }
}
assert.deepEqual(counts,{CAN:13,MEX:32});
assert(codes.has('CA-ON')&&codes.has('CA-QC')&&codes.has('MX-SON')&&codes.has('MX-TAM'));
const html=fs.readFileSync(path.join(root,'weather-viewer.html'),'utf8');
const loader=html.slice(html.indexOf('    function loadSatelliteBoundaries(){'),html.indexOf('    function setSatelliteBoundaryProjection('));
async function check(failed){
  const us={features:[{properties:{abbr:'TX'}}]};
  const context={satBoundaryData:null,satBoundaryPromise:null,satBoundaryUnavailable:false,Promise,
    SAT_BOUNDARY_URL:'us.geojson',renderSatelliteBoundaries(){},console:{warn(){}},
    fetch:async url=>({ok:!failed||url==='us.geojson',status:404,json:async()=>url==='us.geojson'?us:supplement})};
  vm.createContext(context);vm.runInContext(loader,context);
  const data=await context.loadSatelliteBoundaries();
  assert.equal(data.features.length,failed?1:46);
  assert.equal(data.features[0].properties.abbr,'TX');
  assert.equal(context.satBoundaryUnavailable,false,'Supplement failure preserves US outlines');
}
(async()=>{await check(false);await check(true);console.log('PASS: 13 Canadian and 32 Mexican divisions, finite closed geometry, unique codes, US-preserving loader and supplement-failure fallback.');})().catch(error=>{console.error(error);process.exitCode=1;});
