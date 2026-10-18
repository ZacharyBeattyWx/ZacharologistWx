const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'weather-viewer.html'),'utf8');
for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
function block(start,end){return html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));}
const scope={Date,console,TRUECOLOR_BASE:'https://example.test/satellite-truecolor',TRUECOLOR_REGIONAL_FRESH_MINUTES:45};
vm.createContext(scope);
vm.runInContext(block('    function mercator(', '    function loadSatelliteBoundaries(').split('\n')[0],scope);
vm.runInContext(block('    function bboxContains(', '    function pruneSatelliteFrameCache('),scope);
vm.runInContext(block('    const SAT_SECTORS=', '    const MESOSCALE_SECTORS='),scope);
vm.runInContext(block('    function trueColorManifestUrls(', '    async function fetchTrueColorManifest('),scope);
vm.runInContext(block('    function validateLocalizedManifest(', '    function nativeSatelliteManifestUrl('),scope);
const catalog=JSON.parse(vm.runInContext('JSON.stringify(LOCALIZED_SECTORS)',scope));
if(process.argv.includes('--catalog')){
  process.stdout.write(JSON.stringify(catalog,null,2)+'\n');
}else{
  const published=JSON.parse(fs.readFileSync(path.join(root,'aws/satellite-truecolor-publisher/localized-sectors.json'),'utf8'));
  const footprints=Object.fromEntries(Object.entries(catalog).map(([platform,sectors])=>
    [platform,sectors.map(({id,label,bbox})=>({id,label,bbox}))]));
  assert.deepEqual(footprints,published,'Publisher and viewer must use identical footprints and IDs');
  for(const [platform,sectors] of Object.entries(catalog)){
    assert.equal(new Set(sectors.map(sector=>sector.id)).size,sectors.length);
    for(const sector of sectors){
      assert.equal(sector.clientCrop,false);
      const urls=scope.trueColorManifestUrls(platform,sector);
      assert.equal(urls.length,1,'No broad or regional fallback for Localized');
      assert.ok(urls[0].endsWith(`/${platform.toLowerCase()}/sectors/${sector.id}/manifest.json`));
      const lower=scope.mercator(...sector.bbox.slice(0,2));
      const upper=scope.mercator(...sector.bbox.slice(2));
      const height=Math.round(2560*(upper[1]-lower[1])/(upper[0]-lower[0]));
      const manifest={platform,sector:sector.id,nativeLocalized:true,projection:'EPSG:3857',
        cadenceMinutes:5,dayNightComposite:true,bbox:sector.bbox,
        frames:[{time:new Date().toISOString(),path:`${platform.toLowerCase()}/sectors/${sector.id}/v1/2026001.webp`,width:2560,height}]};
      scope.validateLocalizedManifest(manifest,platform,sector);
      for(const altered of [
        {...manifest,nativeLocalized:false},
        {...manifest,sector:'CONUS'},
        {...manifest,projection:'EPSG:4326'},
        {...manifest,bbox:[-126,22,-58,53]},
        {...manifest,frames:[{...manifest.frames[0],path:'east/v15/2026001.webp'}]},
        {...manifest,frames:[{...manifest.frames[0],width:960}]},
        {...manifest,frames:[{...manifest.frames[0],time:new Date(Date.now()-3600000).toISOString()}]},
        {...manifest,frames:[...manifest.frames,...manifest.frames]}
      ])assert.throws(()=>scope.validateLocalizedManifest(altered,platform,sector));
    }
  }
  assert.equal(scope.trueColorManifestUrls('East',{id:'global'})[0],'https://example.test/satellite-truecolor/east-global/manifest.json');
  assert.equal(scope.trueColorManifestUrls('West',{id:'PACUS'})[0],'https://example.test/satellite-truecolor/west/manifest.json');
  let cropCalls=0;
  scope.satFrameVisuals=new WeakMap();
  scope.satelliteFrameReady=()=>true;
  scope.cachedSatelliteFrameResult=()=>({img:{naturalWidth:4400,naturalHeight:3300}});
  scope.document={createElement:()=>({})};
  scope.drawPreparedSatellite=(image,context,canvas)=>{
    cropCalls++;
    canvas.width=1000;canvas.height=563;canvas.satelliteBoundaryBbox=context.bbox;
    return true;
  };
  vm.runInContext(block('    function satelliteFrameVisual(', '    function drawSatelliteTransition('),scope);
  const rgb=scope.satelliteFrameVisual({source:'prepared',url:'rgb.webp'},
    {sector:{nativeLocalized:true},product:{nativeProduct:'clean-ir'},bbox:[1,2,3,4]});
  assert.equal(cropCalls,1,'Existing broad RGB imagery still takes its georeferenced crop path');
  assert.equal(rgb.width,1000,'Broad RGB frames must never be relabeled as dedicated Localized frames');
  const native=scope.satelliteFrameVisual({source:'prepared',url:'localized.webp'},
    {sector:{nativeLocalized:true},product:{prepared:true},bbox:[1,2,3,4]});
  assert.equal(cropCalls,1,'Dedicated True Color reuses the cached canvas directly');
  assert.equal(native.width,4400);
  console.log(`PASS: ${catalog.East.length} East / ${catalog.West.length} West dedicated sectors, catalog parity, manifest validation, broad routing and JS syntax.`);
}
