/* Independent homepage alert map and an explicit, national SPC probability summary. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else api.boot(root);})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
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
      const p=f.properties||{},end=Date.parse(p.ends||p.expiration||'');
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
      alertCard.innerHTML=`<div class="news-panel-heading"><h2>Interactive alert map</h2><a href="level2-mobile-radar.html?view=conus">Open full map ↗</a></div><p class="news-source news-national-scope">National NOAA polygons • independent of the monitoring-area list above</p><div class="news-map-tools"><label for="newsMapAlertType">Show</label><select id="newsMapAlertType"><option value="all">All alert types</option><option value="storm">Storm</option><option value="winter">Winter</option><option value="hydro">Flood</option><option value="tropical">Tropical</option><option value="fire">Fire</option><option value="other">Other</option></select><button id="newsAlertMapReset" type="button">Reset view</button><button id="newsAlertMapRefresh" type="button">Refresh</button></div><div id="newsNationalAlertMap" aria-label="Interactive national watches, warnings and advisories map"></div><p id="newsNationalMapStatus" class="news-source" role="status">Connecting the live alert map…</p><p class="news-map-help">Drag to pan • zoom for detail • click a highlighted area for alert details</p>`;
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
      const canvas=doc.createElement('canvas');canvas.className='news-national-alert-overlay';canvas.setAttribute('aria-hidden','true');const ctx=canvas.getContext('2d');let drawPending=false;
      function draw(){
        drawPending=false;if(!map)return;const width=el.clientWidth,height=el.clientHeight,dpr=Math.min(2,Math.max(1,win.devicePixelRatio||1));
        if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}canvas.style.width=width+'px';canvas.style.height=height+'px';ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.lineJoin='round';ctx.lineCap='round';
        function ring(coords){let started=false;for(const coord of coords||[]){if(!Array.isArray(coord)||!Number.isFinite(coord[0])||!Number.isFinite(coord[1]))continue;const point=map.project(coord);if(started)ctx.lineTo(point.x,point.y);else{ctx.moveTo(point.x,point.y);started=true;}}if(started)ctx.closePath();}
        for(const feature of selected){const geometry=feature.geometry,p=feature.properties||{};ctx.beginPath();if(geometry.type==='Polygon')geometry.coordinates.forEach(ring);else if(geometry.type==='MultiPolygon')geometry.coordinates.forEach(polygon=>polygon.forEach(ring));else continue;const color=p._color||'#8bd9ef';ctx.fillStyle=color;ctx.globalAlpha=/Warning/.test(p.prod_type)?0.28:/Watch/.test(p.prod_type)?0.18:0.09;ctx.fill('evenodd');ctx.globalAlpha=0.9;ctx.strokeStyle=color;ctx.lineWidth=1.1;ctx.stroke();ctx.globalAlpha=1;}
      }
      function scheduleDraw(){if(!drawPending){drawPending=true;win.requestAnimationFrame(draw);}}
      const bounds=[[-125.1,24.2],[-66.4,49.7]];
      const hrefFor=p=>`live-alerts.html?${new URLSearchParams({alert:p.cap_id||'',event:p.prod_type||''})}`;
      function mapData(){selected=filter.value==='all'?all:all.filter(f=>f.properties._category===filter.value);map?.getSource('news-national-alerts')?.setData({type:'FeatureCollection',features:selected});scheduleDraw();const products=productCount(selected);status.textContent=lastSuccess?`NOAA / NWS • ${products} active product${products===1?'':'s'} in this filter • updated ${time(lastSuccess)}`:'Connecting the live alert map…';}
      async function update(){if(inflight)return;inflight=true;status.textContent=all.length?'Refreshing • current polygons remain visible':'Loading live national alert polygons…';
        try{
          // MapServer is the current populated geometry service. Simplify only the preview geometry.
          const base='https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';
          const query=new URLSearchParams({where:'1=1',outFields:'*',returnGeometry:'true',outSR:'4326',f:'geojson',maxAllowableOffset:'0.03',geometryPrecision:'3',resultRecordCount:'1000',resultOffset:'0',orderByFields:'objectid',_:String(Math.floor(Date.now()/60000))});
          const features=[];let offset=0;
          for(let page=0;page<8;page++){
            query.set('resultOffset',String(offset));const data=await json(base+'?'+query);
            if(!Array.isArray(data.features))throw new Error('Alert polygons missing');features.push(...data.features);offset+=data.features.length;
            if(!data.exceededTransferLimit&&!data.properties?.exceededTransferLimit&&data.features.length<1000)break;
            if(page===7)throw new Error('Alert geometry response exceeded preview page limit');
          }
          all=activeGeometry(features).map(f=>{const p={...f.properties};p._category=classifier(p.prod_type);p._color=typeof win.getAlertColor==='function'?win.getAlertColor(p.prod_type):'#8bd9ef';return {...f,properties:p};});
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
        map=new win.mapboxgl.Map({container:el,style:'mapbox://styles/zacharybeattywx/cmpdipwzh00fq01sccdj806xy',center:[-96,38],zoom:2.7,bearing:0,pitch:0,projection:'mercator',renderWorldCopies:false,dragRotate:false,pitchWithRotate:false,cooperativeGestures:true});
        el.appendChild(canvas);['move','zoom','resize'].forEach(event=>map.on(event,scheduleDraw));
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
            const html=features.slice(0,5).map(f=>{const p=f.properties||{},end=Date.parse(p.ends||p.expiration||'');return `<article class="news-map-popup-alert"><strong>${esc(p.prod_type)}</strong>${Number.isFinite(end)?`<p>Until ${esc(new Date(end).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'}))}</p>`:''}<a href="${esc(hrefFor(p))}">Alert details ↗</a></article>`;}).join('');
            new win.mapboxgl.Popup({maxWidth:'300px'}).setLngLat(event.lngLat).setHTML(html).addTo(map);
          });reset();if(lastSuccess&&Date.now()-lastSuccess<60000)mapData();else update();
        });
        map.on('error',()=>{if(!ready)status.textContent='Basemap reconnecting. Open the full map using the link above.';});
        win.setInterval(()=>{if(!doc.hidden&&mapVisible)update();},60000);
      }catch(error){status.textContent='Interactive map reconnecting. Open the full map using the link above.';}
    }
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',init,{once:true});else init();
  }
  return {threatResult,activeGeometry,productCount,boot};
});
