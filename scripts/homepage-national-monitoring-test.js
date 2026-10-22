/* Independent homepage alert map and an explicit, national SPC probability summary. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else api.boot(root);})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  // NOAA WWA renderer product colors, verified 2026-10-20. Source: MapServer/1 drawingInfo.
  const NWS_COLORS={"911 telephone outage":"#c0c0c0","administrative message":"#c0c0c0","air quality alert":"#808080","air stagnation advisory":"#808080","ashfall advisory":"#696969","ashfall warning":"#a9a9a9","avalanche advisory":"#cd853f","avalanche warning":"#1e90ff","avalanche watch":"#f4a460","beach hazards statement":"#40e0d0","blizzard warning":"#ff4500","blowing dust advisory":"#bdb76b","blowing dust warning":"#ffe4c4","blue alert":"#ffffff","brisk wind advisory":"#d8bfd8","child abduction emergency":"#ffffff","civil danger warning":"#ffb6c1","civil emergency message":"#ffb6c1","coastal flood advisory":"#7cfc00","coastal flood statement":"#6b8e23","coastal flood warning":"#228b22","coastal flood watch":"#66cdaa","cold weather advisory":"#afeeee","dense fog advisory":"#708090","dense smoke advisory":"#f0e68c","dust advisory":"#bdb76b","dust storm warning":"#ffe4c4","earthquake warning":"#8b4513","evacuation immediate":"#7fff00","extreme cold warning":"#0000ff","extreme cold watch":"#5f9ea0","extreme fire danger":"#e9967a","extreme heat warning":"#c71685","extreme heat watch":"#800000","extreme wind warning":"#ff8c00","fire warning":"#a0522d","fire weather watch":"#ffdead","flash flood statement":"#8b0000","flash flood warning":"#8b0000","flash flood watch":"#2e8b57","flood advisory":"#00ff7f","flood statement":"#00ff00","flood warning":"#00ff00","flood watch":"#2e8b57","freeze warning":"#483d8b","freeze watch":"#00ffff","freezing fog advisory":"#008080","freezing spray advisory":"#00bfff","frost advisory":"#6495ed","gale warning":"#dda0dd","gale watch":"#ffc0cb","hazardous materials warning":"#4b0082","hazardous seas warning":"#d8bfd8","hazardous seas watch":"#483d8b","hazardous weather outlook":"#eee8aa","heat advisory":"#ff7f50","heavy freezing spray warning":"#00bfff","heavy freezing spray watch":"#bc8f8f","high surf advisory":"#ba55d3","high surf warning":"#228b22","high wind warning":"#daa520","high wind watch":"#b8860b","hurricane force wind warning":"#cd5c5c","hurricane force wind watch":"#9932cc","hurricane warning":"#dc143c","hurricane watch":"#ff00ff","hydrologic outlook":"#90ee90","ice storm warning":"#8b008b","lake effect snow warning":"#008b8b","lake wind advisory":"#d2b48c","lakeshore flood advisory":"#7cfc00","lakeshore flood statement":"#6b8e23","lakeshore flood warning":"#228b22","lakeshore flood watch":"#66cdaa","law enforcement warning":"#c0c0c0","local area emergency":"#c0c0c0","low water advisory":"#a52a2a","marine weather statement":"#ffefd5","nuclear power plant warning":"#4b0082","radiological hazard warning":"#4b0082","red flag warning":"#ff1493","rip current statement":"#40e0d0","severe thunderstorm warning":"#ffa500","severe thunderstorm watch":"#db7093","severe weather statement":"#00ffff","shelter in place warning":"#fa8072","short term forecast":"#98fb98","small craft advisory":"#d8bfd8","snow squall warning":"#c71585","special marine warning":"#ffa500","special weather statement":"#ffe4b5","storm surge warning":"#b524f7","storm surge watch":"#db7ff7","storm warning":"#9400d3","storm watch":"#ffe4b5","test":"#f0ffff","tornado warning":"#ff0000","tornado watch":"#ffff00","tropical cyclone local statement":"#ffe4b5","tropical storm warning":"#b22222","tropical storm watch":"#f08080","tsunami advisory":"#d2691e","tsunami warning":"#fd6347","tsunami watch":"#ff00ff","typhoon warning":"#dc143c","typhoon watch":"#ff00ff","volcano warning":"#2f4f4f","wind advisory":"#d2b48c","winter storm warning":"#ff69b4","winter storm watch":"#4682b4","winter weather advisory":"#7b68ee"};
  const nwsAlertColor=event=>NWS_COLORS[String(event||'').trim().toLowerCase()]||'#b8b8b8';
  function mercatorPoint(coord){const lat=Math.max(-85.05112878,Math.min(85.05112878,coord[1]))*Math.PI/180;return {x:(coord[0]+180)/360,y:(1-Math.log(Math.tan(Math.PI/4+lat/2))/Math.PI)/2};}
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function threatResult(payload){
    if(!Array.isArray(payload?.features)||payload.error)throw new Error('Invalid SPC response');
    if(!payload.features.length)return {status:'not-outlined',percent:null};
    const values=payload.features.map(f=>f.properties?.dn??f.attributes?.dn).filter(v=>v!==null&&v!==undefined&&v!=='').map(Number).filter(v=>Number.isFinite(v)&&v>=0&&v<=100);
    if(!values.length)throw new Error('SPC probability fields missing');
    return {status:'outlined',percent:Math.max(...values)};
  }
  function activeGeometry(features,now=Date.now()){
    return (features||[]).filter(f=>{
      if(!['Polygon','MultiPolygon'].includes(f?.geometry?.type))return false;
      const p=f.properties||{},end=Date.parse(String(p.ends||'').trim()||String(p.expiration||'').trim());
      return !Number.isFinite(end)||end>now;
    });
  }
  function productCount(features){return new Set(features.map(f=>f.properties?.cap_id||f.properties?.url||f.id||f.properties?.objectid)).size;}
  function boot(win){
    const doc=win.document,$=s=>doc.querySelector(s);
    const time=t=>new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
    async function json(url){const response=await win.fetch(url,{cache:'no-store',signal:AbortSignal.timeout(18000)});if(!response.ok)throw new Error(`Weather feed ${response.status}`);const data=await response.json();if(data.error)throw new Error('Weather service response error');return data;}
    function init(){
      const grid=$('#weatherNewsroom .news-monitor-grid');if(!grid||$('#newsNationalAlerts'))return;
      function hideLegacyThreat(){grid.querySelectorAll('.ops-reference-card').forEach(card=>{if(card.querySelector('.ops-reference-kicker')?.textContent.trim()==='SPC Threat Snapshot'){card.classList.add('news-legacy-threat');card.setAttribute('aria-hidden','true');}});}
      hideLegacyThreat();const legacyObserver=new MutationObserver(hideLegacyThreat);grid.querySelectorAll('.ops-reference-rail').forEach(rail=>legacyObserver.observe(rail,{childList:true}));
      const alertCard=doc.createElement('section');alertCard.id='newsNationalAlerts';alertCard.className='news-panel news-national-alert-map';
      alertCard.innerHTML=`<div class="news-panel-heading"><h2>Interactive alert map</h2><a href="level2-mobile-radar.html?view=conus">Open full map ↗</a></div><p class="news-source news-national-scope">National NOAA polygons • independent of the monitoring-area list above</p><div class="news-map-tools"><label for="newsMapAlertType">Show</label><select id="newsMapAlertType"><option value="all">All alert types</option><option value="storm">Storm</option><option value="winter">Winter</option><option value="hydro">Flood</option><option value="tropical">Tropical</option><option value="fire">Fire</option><option value="other">Other</option></select><button id="newsAlertMapReset" type="button">Reset view</button><button id="newsAlertMapRefresh" type="button">Refresh</button></div><div id="newsNationalAlertMap" aria-label="Interactive national watches, warnings and advisories map"></div><p id="newsNationalMapStatus" class="news-source" role="status">Connecting the live alert map…</p><p class="news-map-help">Drag to pan • zoom for detail • click a highlighted area for alert details. NWS colors with translucent fills.</p><details style="padding:0 14px 12px"><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer">NWS alert colors</summary><div id="newsNationalAlertLegend" class="news-spc-legend"></div></details>`;
      grid.appendChild(alertCard);
      const threat=doc.createElement('section');threat.id='newsNationalThreats';threat.className='news-panel news-national-threats';
      threat.innerHTML=`<div class="news-panel-heading"><h2>Day 1 severe probabilities</h2></div><p class="news-source news-national-scope">Highest outlined probability anywhere in the national outlook • not your local risk</p><div id="newsNationalThreatRows"></div><p id="newsNationalThreatStatus" class="news-source" role="status">Checking the official tornado, wind and hail outlooks…</p><a href="https://www.spc.noaa.gov/products/outlook/day1otlk.html" target="_blank" rel="noopener">View the official Day 1 outlook ↗</a>`;
      grid.appendChild(threat);
      setupThreats(threat);setupMap(alertCard);
    }
    function setupThreats(card){
      const rows=card.querySelector('#newsNationalThreatRows'),status=card.querySelector('#newsNationalThreatStatus');
      const hazards=[['tornado','Tornado',3],['wind','Wind',7],['hail','Hail',5]];let inflight=false;const saved=new Map();
      function paint(){rows.innerHTML=hazards.map(([key,label])=>{const item=saved.get(key);return `<article class="news-national-threat-row"><span>${label}</span><strong>${item?(item.result.status==='outlined'?esc(item.result.percent)+'%':'Not outlined'):'See outlook ↗'}</strong><small>${item?(item.result.status==='outlined'?'Highest delineated probability in U.S.':'No risk area delineated for this hazard'):'Official source link below'}</small></article>`;}).join('');}
      async function update(){if(inflight)return;inflight=true;
        const results=await Promise.allSettled(hazards.map(async([key,,layer])=>{
          const data=await json(`https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/FeatureServer/${layer}/query?where=1%3D1&outFields=dn,issue,valid,expire&returnGeometry=false&f=geojson`);
          saved.set(key,{result:threatResult(data),fetchedAt:Date.now()});
        }));
        const failed=results.some(r=>r.status==='rejected');
        for(const [key,item] of saved)if(Date.now()-item.fetchedAt>30*60000)saved.delete(key);
        paint();
        const complete=saved.size===3,empty=complete&&[...saved.values()].every(s=>s.result.status==='not-outlined');
        const latest=saved.size?Math.min(...[...saved.values()].map(s=>s.fetchedAt)):null;
        status.textContent=failed?(latest?`Some feeds reconnecting • saved values checked ${time(latest)}. Use the official outlook for current conditions.`:'Probability feeds reconnecting. The official Day 1 outlook remains available below.'):`${empty?'No severe probability areas are outlined; general thunderstorms may still be forecast. ':''}NOAA / SPC • checked ${time(latest)}`;
        inflight=false;
      }
      paint();update();win.setInterval(()=>{if(!doc.hidden)update();},5*60000);
    }
    async function setupMap(card){
      const el=card.querySelector('#newsNationalAlertMap'),status=card.querySelector('#newsNationalMapStatus'),filter=card.querySelector('#newsMapAlertType');
      const classifier=win.ZachNewsroomData?.alertCategory||(()=> 'other');
      let map,all=[],selected=[],inflight=false,ready=false,lastSuccess=null,mapVisible=true;
      const canvas=doc.createElement('canvas');canvas.className='news-national-alert-overlay';canvas.setAttribute('aria-hidden','true');
      const ctx=canvas.getContext('2d'),paths=new WeakMap();let drawPending=false;
      // Cache geographic paths once. Camera changes only transform them; no per-vertex
      // map.project calls are needed while the user pinches or drags.
      function prepared(feature){
        if(paths.has(feature))return paths.get(feature);
        const geometry=feature.geometry,rings=geometry.type==='Polygon'?geometry.coordinates:geometry.coordinates.flat();
        const first=rings.find(r=>r.length)?.[0];if(!first)return null;
        const origin=mercatorPoint(first),path=new win.Path2D(),bounds={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
        for(const ring of rings){let started=false;for(const coord of ring){if(!Number.isFinite(coord[0])||!Number.isFinite(coord[1]))continue;
          const point=mercatorPoint(coord);bounds.left=Math.min(bounds.left,point.x);bounds.top=Math.min(bounds.top,point.y);bounds.right=Math.max(bounds.right,point.x);bounds.bottom=Math.max(bounds.bottom,point.y);
          if(started)path.lineTo(point.x-origin.x,point.y-origin.y);else{path.moveTo(point.x-origin.x,point.y-origin.y);started=true;}
        }if(started)path.closePath();}
        const item={path,origin,bounds};paths.set(feature,item);return item;
      }
      function draw(){
        drawPending=false;if(!map)return;const width=el.clientWidth,height=el.clientHeight,dpr=Math.min(2,Math.max(1,win.devicePixelRatio||1));
        if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
        canvas.style.width=width+'px';canvas.style.height=height+'px';ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
        const west=map.project([-180,0]),east=map.project([180,0]),scale=east.x-west.x;if(!(scale>0))return;
        const offsetX=west.x,offsetY=west.y-scale/2;ctx.lineJoin='round';ctx.lineCap='round';
        for(const feature of selected){const item=prepared(feature);if(!item)continue;const b=item.bounds;
          if(b.right*scale+offsetX < -2||b.left*scale+offsetX > width+2||b.bottom*scale+offsetY < -2||b.top*scale+offsetY > height+2)continue;
          const p=feature.properties||{},color=p._color||'#b8b8b8';
          ctx.setTransform(scale*dpr,0,0,scale*dpr,(offsetX+item.origin.x*scale)*dpr,(offsetY+item.origin.y*scale)*dpr);
          ctx.fillStyle=color;ctx.globalAlpha=/Warning/.test(p.prod_type)?0.3:/Watch/.test(p.prod_type)?0.22:0.16;ctx.fill(item.path,'evenodd');
          ctx.globalAlpha=1;ctx.strokeStyle=color;ctx.lineWidth=1.1/scale;ctx.stroke(item.path);
        }
        ctx.globalAlpha=1;
      }
      function scheduleDraw(){if(!drawPending){drawPending=true;win.requestAnimationFrame(draw);}}
      const bounds=[[-125.1,24.2],[-66.4,49.7]];
      const hrefFor=p=>`live-alerts-test.html?${new URLSearchParams({alert:p.cap_id||'',event:p.prod_type||''})}`;
      function mapData(){selected=filter.value==='all'?all:all.filter(f=>f.properties._category===filter.value);map?.getSource('news-national-alerts')?.setData({type:'FeatureCollection',features:selected});selected.forEach(prepared);scheduleDraw();const legend=card.querySelector('#newsNationalAlertLegend');if(legend){const products=new Map(selected.map(f=>[f.properties.prod_type,f.properties._color]));legend.innerHTML=[...products].sort(([a],[b])=>a.localeCompare(b)).map(([name,color])=>`<span class="spc-legend-item"><i class="spc-legend-swatch" style="background:${esc(color)}"></i>${esc(name)}</span>`).join('');}const products=productCount(selected);status.textContent=lastSuccess?`NOAA / NWS • ${products} active product${products===1?'':'s'} in this filter • updated ${time(lastSuccess)}`:'Connecting the live alert map…';}
      async function update(){if(inflight)return;inflight=true;status.textContent=all.length?'Refreshing • current polygons remain visible':'Loading live national alert polygons…';
        try{
          // MapServer is the current populated geometry service. Simplify only the preview geometry.
          const base='https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';
          const query=new URLSearchParams({where:'1=1',outFields:'*',returnGeometry:'true',outSR:'4326',f:'geojson',maxAllowableOffset:'0.03',geometryPrecision:'3',resultRecordCount:'1000',resultOffset:'0',orderByFields:'objectid',_:String(Date.now())});
          const features=[];let offset=0;
          for(let page=0;page<8;page++){
            query.set('resultOffset',String(offset));let data=await json(base+'?'+query);
            // The national service can return an empty snapshot while it republishes.
            // Retry a fresh request before describing the map as having no products.
            if(page===0&&Array.isArray(data.features)&&!data.features.length){query.set('_',String(Date.now())+'-retry');data=await json(base+'?'+query);}
            if(!Array.isArray(data.features))throw new Error('Alert polygons missing');features.push(...data.features);offset+=data.features.length;
            if(!data.exceededTransferLimit&&!data.properties?.exceededTransferLimit&&data.features.length<1000)break;
            if(page===7)throw new Error('Alert geometry response exceeded preview page limit');
          }
          all=activeGeometry(features).map(f=>{const p={...f.properties};p._category=classifier(p.prod_type);p._color=nwsAlertColor(p.prod_type);return {...f,properties:p};});
          // Draw lower-priority areas first; urgent warning polygons remain visible above them.
          all.sort((a,b)=>{const rank=p=>/Tornado Warning/.test(p.prod_type)?5:/Severe Thunderstorm Warning/.test(p.prod_type)?4:/Flash Flood Warning/.test(p.prod_type)?3:/Warning/.test(p.prod_type)?2:/Watch/.test(p.prod_type)?1:0;return rank(a.properties)-rank(b.properties);});
          lastSuccess=Date.now();mapData();
        }catch(error){all=activeGeometry(all);if(ready)mapData();status.textContent=lastSuccess?`Alert feed reconnecting • showing polygons last updated ${time(lastSuccess)}`:'Alert feed reconnecting. Open the full map or alert explorer for current products.';}
        finally{inflight=false;}
      }
      try{
        // Fetch geometry ahead of scrolling; defer WebGL until the map approaches the screen.
        win.setTimeout(()=>{if(!lastSuccess&&!inflight)update();},1200);
        // The bottom map does not compete with radar during initial mobile loading.
        if('IntersectionObserver' in win)await new Promise(resolve=>{
          let started=false;const observer=new win.IntersectionObserver(entries=>{
            mapVisible=entries[0].isIntersecting;
            if(mapVisible&&!started){started=true;resolve();}
            else if(mapVisible&&ready&&lastSuccess&&Date.now()-lastSuccess>60000)update();
          },{rootMargin:'1200px'});observer.observe(card);
        });
        // The SPC panel loads the same public Mapbox runtime once for the homepage.
        const until=Date.now()+18000;while((!win.mapboxgl||!win.MAPBOX_PUBLIC_TOKEN)&&Date.now()<until)await new Promise(r=>win.setTimeout(r,100));
        if(!win.mapboxgl||!win.MAPBOX_PUBLIC_TOKEN)throw new Error('Map runtime missing');
        win.mapboxgl.accessToken=win.MAPBOX_PUBLIC_TOKEN;
        map=new win.mapboxgl.Map({container:el,style:'mapbox://styles/zacharybeattywx/cmpdipwzh00fq01sccdj806xy',center:[-96,38],zoom:2.7,bearing:0,pitch:0,projection:'mercator',renderWorldCopies:false,dragRotate:false,pitchWithRotate:false,touchPitch:false,maxPitch:0,cooperativeGestures:true});
        el.appendChild(canvas);
        // Draw in Mapbox's render event, before the browser paints that same frame.
        // A second requestAnimationFrame from move/zoom leaves the overlay one frame behind.
        map.on('render',draw);map.on('moveend',draw);map.on('resize',draw);
        map.addControl(new win.mapboxgl.NavigationControl({showCompass:false}),'top-right');map.touchZoomRotate.disableRotation();
        const reset=()=>{map.resize();map.fitBounds(bounds,{padding:16,duration:0});};
        card.querySelector('#newsAlertMapReset').addEventListener('click',reset);card.querySelector('#newsAlertMapRefresh').addEventListener('click',update);filter.addEventListener('change',mapData);
        new ResizeObserver(()=>map.resize()).observe(el);
        map.on('load',()=>{ready=true;map.addSource('news-national-alerts',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
          // Mapbox handles interaction; the same external-canvas approach as the site's other weather maps draws colors.
          map.addLayer({id:'news-national-alert-fill',type:'fill',source:'news-national-alerts',paint:{'fill-color':'#ffffff','fill-opacity':0.001}});
          map.on('mouseenter','news-national-alert-fill',()=>{map.getCanvas().style.cursor='pointer';});map.on('mouseleave','news-national-alert-fill',()=>{map.getCanvas().style.cursor='';});
          map.on('click','news-national-alert-fill',event=>{
            const seen=new Set(),features=(event.features||[]).filter(f=>{const key=f.properties?.cap_id||f.properties?.objectid;if(seen.has(key))return false;seen.add(key);return true;});
            if(!features.length)return;
            const html=features.slice(0,5).map(f=>{const p=f.properties||{},end=Date.parse(String(p.ends||'').trim()||String(p.expiration||'').trim());return `<article class="news-map-popup-alert"><strong>${esc(p.prod_type)}</strong>${Number.isFinite(end)?`<p>Until ${esc(new Date(end).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'}))}</p>`:''}<a href="${esc(hrefFor(p))}">Alert details ↗</a></article>`;}).join('');
            new win.mapboxgl.Popup({maxWidth:'300px'}).setLngLat(event.lngLat).setHTML(html).addTo(map);
          });reset();if(lastSuccess&&Date.now()-lastSuccess<60000)mapData();else update();
        });
        map.on('error',()=>{if(!ready)status.textContent='Basemap reconnecting. Open the full map using the link above.';});
        win.setInterval(()=>{if(!doc.hidden&&mapVisible)update();},60000);
      }catch(error){status.textContent='Interactive map reconnecting. Open the full map using the link above.';}
    }
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',init,{once:true});else init();
  }
  return {threatResult,activeGeometry,productCount,nwsAlertColor,mercatorPoint,boot};
});
