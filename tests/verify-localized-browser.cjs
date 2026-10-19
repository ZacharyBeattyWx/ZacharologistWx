const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const catalog=require('../aws/satellite-truecolor-publisher/localized-sectors.json');
const sector=catalog.East.find(item=>item.id==='loc-cod-NC_VA');
const image=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1440"><defs><linearGradient id="sky"><stop stop-color="#12416b"/><stop offset="1" stop-color="#76a990"/></linearGradient></defs><path fill="url(#sky)" d="M0 0H2560V1440H0Z"/><path fill="#fff" opacity=".8" d="M200 300Q1000 900 2200 500L2200 700Q900 1100 200 500Z"/><text x="100" y="150" fill="white" font-size="64">Localized runtime test fixture</text></svg>');
const server=http.createServer((request,response)=>{
  const requested=path.resolve(root,'.'+new URL(request.url,'http://localhost').pathname);
  if(!requested.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  try{
    const extension=path.extname(requested);
    response.setHeader('Content-Type',extension==='.html'?'text/html':extension==='.js'?'text/javascript':'application/json');
    let body=fs.readFileSync(requested);
    if(requested.endsWith(`${path.sep}weather-viewer.html`)){
      body=body.toString().replace('restoreViewerState();populateSatelliteSectors();selectProduct(activeProduct);',
        `window.__localizedTest={refresh:()=>resetSatelliteViewer(true),cache:()=>({
          bytes:[...satFrameImages.values()].reduce((total,image)=>total+image.naturalWidth*image.naturalHeight*4,0),
          shared:satFrames.every(frame=>satelliteFrameVisual(frame,satContext)?.source===satFrameImages.get(frame.url)),
          bbox:satBoundaryProjection.bbox,expectedBbox:satContext.bbox
        })};restoreViewerState();populateSatelliteSectors();selectProduct(activeProduct);`);
    }
    response.end(body);
  }catch{response.writeHead(404).end();}
});

async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'chrome'});
  try{
    for(const mobile of [true,false]){
      const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},deviceScaleFactor:mobile?3:1.5});
      const page=await context.newPage();
      const errors=[];
      const requested=[];
      let mode='valid';
      page.on('pageerror',error=>errors.push(error.stack));
      await page.addInitScript(()=>sessionStorage.setItem('zwx-weather-viewer-state-v1',JSON.stringify({
        activeProduct:'satellite',satPlatform:'East',satProduct:'TrueColor',satSector:'loc-cod-NC_VA',satLoopFrameCount:24
      })));
      await page.route('**/*',async route=>{
        const url=route.request().url();
        if(url.includes('/mosaic-radar-home.html'))return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Radar iframe fixture</title>'});
        if(url.startsWith('http://127.0.0.1:'))return route.continue();
        requested.push(url);
        if(url.includes('/satellite-truecolor/east/sectors/loc-cod-NC_VA/manifest.json')){
          if(mode==='missing')return route.fulfill({status:404,body:'not deployed'});
          const frames=Array.from({length:25},(_,index)=>({time:new Date(Date.now()-(24-index)*5*60000).toISOString(),
            path:`east/sectors/${sector.id}/frames/v1/frame${index}.webp`,width:2560,height:1440}));
          const manifest={platform:'East',sector:sector.id,bbox:sector.bbox,nativeLocalized:true,projection:'EPSG:3857',
            cadenceMinutes:5,frameCount:frames.length,frames,dayNightComposite:true,sourceProduct:'ABI-L1b-RadC C01+C02+C03+C13',recipe:{resolutionKm:0.27}};
          if(mode==='mismatch')manifest.bbox=[-126,22,-58,53];
          if(mode==='stale')manifest.frames=frames.map(frame=>({...frame,time:new Date(Date.parse(frame.time)-3600000).toISOString()}));
          return route.fulfill({json:manifest});
        }
        if(url.includes(`/east/sectors/${sector.id}/frames/`)){
          if(mode==='missing-image')return route.fulfill({status:404,body:'not published'});
          return route.fulfill({contentType:'image/svg+xml',body:image});
        }
        if(url.includes('mapbox-gl.js'))return route.fulfill({body:'window.mapboxgl={};'});
        return route.abort();
      });
      const address=`http://127.0.0.1:${server.address().port}/weather-viewer.html`;
      await page.goto(address);
      await page.waitForFunction(()=>!document.getElementById('satelliteCanvas').hidden&&
        !document.getElementById('satelliteLoading').classList.contains('show'));
      const startupImages=requested.filter(url=>url.includes('/frames/')).length;
      if(mobile)assert.ok(startupImages<=1,'Mobile startup loads the newest frame first');
      await page.locator('#satPlay').click();
      await page.waitForFunction(()=>document.getElementById('satPlay').textContent.includes('Pause'));
      await page.waitForTimeout(1300);
      const dimensions=await page.locator('#satelliteCanvas').evaluate(canvas=>({width:canvas.width,height:canvas.height}));
      await page.locator('#satPlay').click();
      assert.ok(dimensions.width>=(mobile?1400:1900));
      assert.ok(Math.abs(dimensions.width/dimensions.height-16/9)<0.01);
      const cache=await page.evaluate(()=>window.__localizedTest.cache());
      assert.ok(cache.bytes<=(mobile?128:224)*1024*1024,'Decoded loop stays within its pixel budget');
      assert.ok(cache.shared,'Playback reuses cached canvases without retaining a second canvas per frame');
      assert.deepEqual(cache.bbox,cache.expectedBbox,'Outlines and imagery use the same Mercator bbox');
      assert.ok(requested.filter(url=>url.includes('/frames/')).length<=25,'Immutable frame URLs are reused');
      const loadedImages=requested.filter(url=>url.includes('/frames/')).length;
      await page.evaluate(()=>window.__localizedTest.refresh());
      assert.equal(requested.filter(url=>url.includes('/frames/')).length,loadedImages,'Same-sector refresh reuses immutable decoded frames');
      assert.ok(!requested.some(url=>url.includes('gibs.earthdata')||/\/east\/manifest.json/.test(url)));
      if(process.env.LOCALIZED_SCREENSHOT)await page.screenshot({path:path.resolve(process.env.LOCALIZED_SCREENSHOT,`localized-${mobile?'mobile':'desktop'}.png`)});
      for(const unavailable of ['missing','mismatch','stale','missing-image']){
        mode=unavailable;
        await page.reload();
        await page.waitForFunction(()=>document.getElementById('viewerStatus').textContent==='Satellite unavailable');
        assert.ok(await page.locator('#satelliteCanvas').evaluate(canvas=>canvas.hidden));
        assert.ok(await page.locator('#satPlay').isDisabled());
        assert.match(await page.locator('#satelliteLoading').textContent(),unavailable==='missing-image'?/Satellite frame temporarily unavailable/:/High-resolution Localized imagery is currently unavailable/);
        assert.ok(!requested.some(url=>url.includes('gibs.earthdata')||/\/east\/manifest.json/.test(url)));
      }
      assert.deepEqual(errors,[],'Viewer has no runtime exceptions');
      await context.close();
      console.log(`PASS: ${mobile?'mobile DPR 3':'desktop'} dedicated playback, aspect ratio, bounded decode, no crop fallback, missing/mismatched/stale unavailable states.`);
    }
  }finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
