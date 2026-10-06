const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || require('node:path').resolve(__dirname, '..', 'weather-viewer.html'), 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
const section = html.slice(html.indexOf('    let mesoscaleLoadToken='), html.indexOf('    function showRadar(){'));
const now = Date.now();
function filename(time, location='22N-93W', satellite='19', channel='13') {
  const date = new Date(time), year = date.getUTCFullYear();
  const day = Math.floor((time - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const pad = (value, size=2) => String(value).padStart(size, '0');
  return `${year}${pad(day,3)}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}_GOES${satellite}-ABI-MESO-${channel}-${location}-1000x1000.jpg`;
}
const listing = (times, location) => times.map(time => `<a href="${filename(time,location)}">frame</a>`).join('');
function setup(mode='success') {
  const elements=new Map(), element=id=>{
    if(!elements.has(id))elements.set(id,{hidden:false,value:'13',textContent:'',disabled:false});
    return elements.get(id);
  };
  const context={Date,URL,Promise,Number,AbortSignal,setTimeout,clearTimeout,
    DOMParser:class {parseFromString(html){return {querySelectorAll(){return [...html.matchAll(/href="([^"]+)"/g)].map(match=>({getAttribute:()=>match[1]}));}};}},
    Image:class {set src(url){this.url=url;queueMicrotask(()=>mode==='image-error'?this.onerror():this.onload());}get src(){return this.url;}},
    document:{hidden:false,getElementById:element,querySelector:element,querySelectorAll:()=>[]},
    satWarmGeneration:1,satPlatform:'East',activeProduct:'satellite',satRenderToken:0,satPlayGateToken:0,
    satFrames:[],satAvailableFrames:[],satFrameIndex:0,satContext:null,satLoopFrameCount:24,satLoopFrameStride:1,
    satPlay:element('satPlay'),satPrev:element('satPrev'),satNext:element('satNext'),satTimeline:element('satTimeline'),
    satCacheReadout:element('satCacheReadout'),satFrameReadout:element('satFrameReadout'),satSpeed:{value:'250'},satTimer:0,satPlayPreparing:false,
    currentSectorSpec:()=>({id:'meso-1',mesoscale:true,mesoNumber:1}),
    satelliteStage:{classList:{add(){},remove(){}},style:{removeProperty(){},setProperty(){}}},
    satelliteCanvas:{},satelliteImage:{hidden:true},satelliteLoading:{classList:{add(){},remove(){}}},
    satelliteTitle:{},satelliteMeta:{},viewerStatus:{},viewerNote:{},console:{warn(){}},
    showSatellite(){},setSatelliteProductControlsEnabled(){},clearSatelliteBoundaries(){},clearSectorPreview(){},resetSatellitePan(){},
    formatSatelliteTime:date=>date.toISOString(),
    selectSatelliteLoopFrames:(frames,count,stride)=>frames.slice().reverse().filter((_,i)=>i%stride===0).slice(0,count).reverse(),
    fetch:async url=>({ok:true,text:async()=>{
      if(mode==='fallback')throw Error('History offline');
      if(mode==='switch')context.satWarmGeneration++;
      return listing(Array.from({length:30},(_,i)=>now-(mode==='stale'?60:30-i)*60000)).replaceAll('ABI-MESO-13-',`ABI-MESO-${element('satMesoChannel').value}-`);
    },json:async()=>({meta:{valid:new Date(now-(mode==='stale'?60:1)*60000).toISOString()}})}),
    requestAnimationFrame:callback=>{context.tick=callback;return 1;},
    stopSatellitePlayback:()=>{context.satTimer=0;context.satPlayGateToken++;context.satPlayPreparing=false;}
  };
  vm.createContext(context);
  vm.runInContext(section+'\nthis.show=showMesoscaleImage;this.parse=parseMesoscaleHistory;this.render=renderMesoscaleFrame;this.play=startMesoscalePlayback;this.warm=warmMesoscaleFrames;this.cached=cachedMesoscaleImage;this.cache=mesoscaleImages;',context);
  return {context,elements};
}
(async()=>{
  const test=setup(),c=test.context,base='https://cdn.star.nesdis.noaa.gov/GOES19/ABI/MESO/M1/13/';
  const parsed=c.parse(listing([now-120000,now-60000])+listing([now-180000],'33N-107W')+'<a href="https://evil.invalid/image.jpg">bad</a>',base,now);
  assert.equal(parsed.length,2);assert(parsed.every(frame=>frame.url.startsWith(base)));
  assert.equal(c.parse(listing([now-60000,now-60000]),base,now).length,1);
  assert.throws(()=>c.parse(listing([now-30*60000]),base,now),/stale/);
  const midnight=Date.UTC(2027,0,1,0,1);
  assert.equal(c.parse(listing([midnight-120000,midnight-60000]),base,midnight).length,2);
  for(const satellite of ['19','18'])for(const sector of [1,2])for(const channel of ['02','13','GEOCOLOR']){
    const url=`https://cdn.star.nesdis.noaa.gov/GOES${satellite}/ABI/MESO/M${sector}/${channel}/`;
    const input=`<a href="${filename(now-60000,'22N-93W',satellite,channel)}">frame</a>`;
    assert.equal(c.parse(input,url,now).length,1);
  }
  await c.show(c.currentSectorSpec());await c.warm(c.satWarmGeneration);
  assert.equal(c.satFrames.length,24);assert.equal(test.elements.get('.sat-playback').hidden,false);
  assert.equal(c.satPlay.disabled,false);assert.match(c.satelliteImage.src,/1000x1000.jpg/);
  await c.render(0);assert.equal(c.satFrameIndex,0);
  await c.play();assert.equal(c.satTimer,1);c.tick(1);await new Promise(setImmediate);
  assert.equal(c.satFrameIndex,1);
  c.tick(100);await new Promise(setImmediate);assert.equal(c.satFrameIndex,1);
  c.tick(251);await new Promise(setImmediate);assert.equal(c.satFrameIndex,2);
  c.stopSatellitePlayback();c.satSpeed.value='100';await c.play();
  c.tick(300);await new Promise(setImmediate);assert.equal(c.satFrameIndex,3);
  c.tick(350);await new Promise(setImmediate);assert.equal(c.satFrameIndex,3);
  c.tick(400);await new Promise(setImmediate);assert.equal(c.satFrameIndex,4);
  c.document.hidden=true;c.tick(1000);assert.equal(c.satTimer,0);
  for(let i=0;i<40;i++)await c.cached(`https://test.invalid/${i}.jpg`);
  assert(c.cache.size<=32);
  const before=c.cache.size;c.activeProduct='radar';
  await c.warm(c.satWarmGeneration);assert.equal(c.cache.size,before);
  for(const mode of ['stale','switch','image-error']){
    const failure=setup(mode);await failure.context.show(failure.context.currentSectorSpec());
    assert.equal(failure.context.satelliteImage.hidden,true);
    assert(!/live$/.test(failure.context.viewerStatus.textContent));
  }
  const fallback=setup('fallback');await fallback.context.show(fallback.context.currentSectorSpec());
  assert.equal(fallback.context.satFrames.length,1);assert.equal(fallback.context.satPlay.disabled,true);
  assert.match(fallback.context.viewerNote.textContent,/history unavailable/);
  const color=setup();color.context.document.getElementById('satMesoChannel').value='GEOCOLOR';
  await color.context.show(color.context.currentSectorSpec());
  assert.equal(color.context.satFrames.length,24);assert.match(color.context.satelliteTitle.textContent,/GeoColor/);
  assert.match(color.context.satelliteImage.src,/GEOCOLOR/);
  const colorFailure=setup('fallback');colorFailure.context.document.getElementById('satMesoChannel').value='GEOCOLOR';
  await colorFailure.context.show(colorFailure.context.currentSectorSpec());
  assert.equal(colorFailure.context.satFrames.length,0);assert.equal(colorFailure.context.satelliteImage.hidden,true);
  console.log('PASS: NOAA East/West M1/M2 C02/C13/GeoColor history, UTC rollover, location isolation, stale/malicious/duplicate filtering, playback/scrubbing and X1/X2 timing, hidden-tab pause, bounded cache, switching/errors, live fallback, no false GeoColor fallback.');
})().catch(error=>{console.error(error);process.exitCode=1;});
