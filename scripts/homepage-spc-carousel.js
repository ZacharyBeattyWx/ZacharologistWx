/* Homepage SPC slideshow: same Mapbox style, colors and canvas paths as Maps & Models. */
(() => {
  'use strict';
      const SPC_FEATURE_SERVER = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/FeatureServer";
      const MAPBOX_STYLE = "mapbox://styles/zacharybeattywx/cmpdipwzh00fq01sccdj806xy";
      const US_BOUNDS = [[-125.1, 24.2], [-66.4, 49.7]];

      const categoricalColors = {
        2: { fill: "#c1e9c1", stroke: "#55bb55", label: "TSTM" },
        3: { fill: "#66a366", stroke: "#005500", label: "MRGL" },
        4: { fill: "#ffe066", stroke: "#ddaa00", label: "SLGT" },
        5: { fill: "#ffa366", stroke: "#ff6600", label: "ENH" },
        6: { fill: "#e06666", stroke: "#cc0000", label: "MDT" },
        8: { fill: "#ee99ee", stroke: "#cc00cc", label: "HIGH" }
      };

      const probabilityColors = {
        2:  { fill: "#8bd48b", stroke: "#2a8a2a", label: "2%" },
        5:  { fill: "#8b5a2b", stroke: "#5f3b1c", label: "5%" },
        10: { fill: "#ffd34d", stroke: "#c99c00", label: "10%" },
        15: { fill: "#ff5b5b", stroke: "#c91515", label: "15%" },
        30: { fill: "#e65ad6", stroke: "#a81897", label: "30%" },
        45: { fill: "#a66be0", stroke: "#6e35aa", label: "45%" },
        60: { fill: "#4e8ee8", stroke: "#1759aa", label: "60%" },
        75: { fill: "#58c9e8", stroke: "#147a95", label: "75%" },
        90: { fill: "#c7f0ff", stroke: "#5ab2cf", label: "90%" }
      };

      function cleanColor(value) {
        const text = String(value || "").trim();
        if (/^#[0-9a-f]{6}$/i.test(text)) return text;
        return "";
      }

      function formatSpcTime(value) {
        const text = String(value || "").trim();
        if (!text) return "time unavailable";

        const compact = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
        if (compact) {
          return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}Z`;
        }

        return text.replace(/T/g, " ").replace(/Z$/i, "Z");
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

      function fallbackStyle(kind, dn) {
        const lookup = kind === "categorical" ? categoricalColors : probabilityColors;
        return lookup[Number(dn)] || {
          fill: "#58a6ff",
          stroke: "#dcecff",
          label: String(dn || "")
        };
      }

      function spcInteractionLayerId(day) {
        return `spc-risk-interaction-${day}`;
      }

      function ensureSpcHitboxLayer(map, sourceId, day) {
        const interactionId = spcInteractionLayerId(day);

        if (!map.getLayer(interactionId)) {
          map.addLayer({
            id: interactionId,
            type: "fill",
            source: sourceId,
            paint: {
              // Hit-testing only. Visible SPC polygons are drawn on a canvas
              // exactly like the radar/alert overlay approach used elsewhere.
              "fill-color": "#ffffff",
              "fill-opacity": 0.001
            }
          });
        }

        return interactionId;
      }

      function drawSpcRingPath(ctx, map, ring) {
        if (!Array.isArray(ring) || ring.length < 2) return;

        let started = false;

        for (const coord of ring) {
          if (!Array.isArray(coord) || coord.length < 2) continue;

          const lon = Number(coord[0]);
          const lat = Number(coord[1]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

          const point = map.project([lon, lat]);

          if (!started) {
            ctx.moveTo(point.x, point.y);
            started = true;
          } else {
            ctx.lineTo(point.x, point.y);
          }
        }

        if (started) ctx.closePath();
      }

      function drawSpcGeometryPath(ctx, map, geometry) {
        if (!geometry) return false;

        if (geometry.type === "Polygon") {
          for (const ring of geometry.coordinates || []) {
            drawSpcRingPath(ctx, map, ring);
          }
          return true;
        }

        if (geometry.type === "MultiPolygon") {
          for (const polygon of geometry.coordinates || []) {
            for (const ring of polygon || []) {
              drawSpcRingPath(ctx, map, ring);
            }
          }
          return true;
        }

        return false;
      }

      function decorateSpcGeoJson(kind, geojson) {
        const features = Array.isArray(geojson?.features) ? geojson.features : [];

        features.forEach((feature) => {
          const p = feature.properties || (feature.properties = {});
          const fallback = fallbackStyle(kind, p.dn);
          const numericRisk = Number(p.dn);

          p._zwxKind = kind;
          p._zwxRisk = Number.isFinite(numericRisk) ? String(numericRisk) : String(p.dn ?? "");
          p._zwxFill = fallback.fill;
          p._zwxStroke = fallback.stroke;
          p._zwxLabel = p.label2 || p.label || fallback.label || `Value ${p.dn ?? ""}`;
        });

        return geojson;
      }

      function makeLegend(container, kind, features) {
        container.innerHTML = "";
        const seen = new Set();
        const rows = [];

        for (const feature of features) {
          const p = feature.properties || {};
          const key = String(p.dn ?? p.label ?? "");
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const fallback = fallbackStyle(kind, p.dn);
          rows.push({
            sort: Number(p.dn) || 0,
            label: p.label2 || p.label || fallback.label || key,
            color: fallback.fill
          });
        }

        rows.sort((a, b) => a.sort - b.sort);

        rows.forEach((row) => {
          const item = document.createElement("span");
          item.className = "spc-legend-item";
          item.innerHTML = `<span class="spc-legend-swatch" style="background:${escapeHtml(row.color)}"></span>${escapeHtml(row.label)}`;
          container.appendChild(item);
        });
      }


  const slides=[
    {label:'Day 1',layer:1,kind:'categorical'},
    {label:'Day 2',layer:9,kind:'categorical'},
    {label:'Day 3',layer:17,kind:'categorical'},
    {label:'Day 4',layer:21,kind:'probability'},
    {label:'Day 5',layer:22,kind:'probability'},
    {label:'Day 6',layer:23,kind:'probability'},
    {label:'Day 7',layer:24,kind:'probability'},
    {label:'Day 8',layer:25,kind:'probability'}
  ];
  const cached=new Map();
  function script(src) {
    return new Promise((resolve,reject)=>{
      const el=document.createElement('script');el.src=src;
      el.onload=resolve;el.onerror=()=>reject(new Error('Map assets reconnecting'));
      document.head.appendChild(el);
    });
  }
  async function init(){
    const slot=document.querySelector('#newsSpcSlot');if(!slot)return;
    // Replace the old bitmap slideshow after legacy scripts have bound to its original nodes.
    slot.innerHTML=`<section class="news-spc-carousel" aria-label="SPC outlook slideshow">
      <div class="news-spc-header"><h3 id="newsSpcTitle">Day 1 Convective Outlook</h3><a href="maps.html">Maps & Models ↗</a></div>
      <div class="news-spc-days" aria-label="Choose outlook day">${slides.map((s,i)=>`<button type="button" data-news-spc="${i}" aria-pressed="${i===0}">${s.label}</button>`).join('')}</div>
      <div id="newsSpcMap" class="spc-map" aria-label="Interactive SPC outlook map"></div>
      <div class="news-spc-legend" id="newsSpcLegend"></div>
      <p class="news-source" id="newsSpcStatus">Loading the Maps & Models basemap…</p>
      <div class="news-spc-controls"><button type="button" id="newsSpcPrev" aria-label="Previous outlook">‹</button><span id="newsSpcCounter">01 / 08</span><button type="button" id="newsSpcNext" aria-label="Next outlook">›</button><button type="button" id="newsSpcPause" aria-pressed="false">Pause rotation</button><a id="newsSpcSource" href="https://www.spc.noaa.gov/products/outlook/day1otlk.html" target="_blank" rel="noopener">Official SPC outlook ↗</a></div>
    </section>`;
    const el=slot.querySelector('#newsSpcMap'), title=slot.querySelector('#newsSpcTitle'), status=slot.querySelector('#newsSpcStatus'), legend=slot.querySelector('#newsSpcLegend');
    let map, ready=false, index=0, paused=false, hovered=false, focused=false, visible=true,serial=0,features=[],kind='categorical',queued=false;
    const canvas=document.createElement('canvas');canvas.className='spc-outlook-overlay';canvas.setAttribute('aria-hidden','true');
    const ctx=canvas.getContext('2d');
    function draw(){
      queued=false;if(!map)return;
      const w=el.clientWidth,h=el.clientHeight,dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1));
      if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
      canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      ctx.lineJoin='round';ctx.lineCap='round';
      for(const feature of [...features].sort((a,b)=>Number(a.properties?.dn)-Number(b.properties?.dn))){
        const style=fallbackStyle(kind,feature.properties?.dn);
        ctx.beginPath();if(!drawSpcGeometryPath(ctx,map,feature.geometry))continue;
        ctx.fillStyle=style.fill;ctx.globalAlpha=kind==='categorical'?.58:.5;ctx.fill('evenodd');
        ctx.globalAlpha=1;ctx.strokeStyle=style.stroke;ctx.lineWidth=1.6;ctx.stroke();
        ctx.globalAlpha=.28;ctx.strokeStyle='#fff';ctx.lineWidth=.55;ctx.stroke();ctx.globalAlpha=1;
      }
    }
    function schedule(){if(!queued){queued=true;requestAnimationFrame(draw);}}
    function reset(){if(!map)return;map.resize();map.fitBounds(US_BOUNDS,{padding:16,duration:0,maxZoom:4.15});schedule();}
    async function show(next){
      index=(next+slides.length)%slides.length;const slide=slides[index],request=++serial;
      slot.querySelectorAll('[data-news-spc]').forEach((button,i)=>button.setAttribute('aria-pressed',String(i===index)));
      title.textContent=slide.label+(slide.kind==='categorical'?' Convective Outlook':' Severe Probability');
      slot.querySelector('#newsSpcCounter').textContent=String(index+1).padStart(2,'0')+' / 08';
      slot.querySelector('#newsSpcSource').href=index<3?`https://www.spc.noaa.gov/products/outlook/day${index+1}otlk.html`:'https://www.spc.noaa.gov/products/exper/day4-8/';
      if(!ready)return;
      features=[];map.getSource('news-spc')?.setData({type:'FeatureCollection',features:[]});legend.replaceChildren();schedule();
      status.textContent='Loading '+slide.label+' official SPC polygons…';
      try{
        let entry=cached.get(slide.layer);
        if(!entry||Date.now()-entry.time>5*60000){
          const response=await fetch(`${SPC_FEATURE_SERVER}/${slide.layer}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`,{signal:AbortSignal.timeout(12000)});
          if(!response.ok)throw new Error('SPC feed reconnecting');
          const json=await response.json();if(json.error||!Array.isArray(json.features))throw new Error('Invalid SPC response');
          entry={time:Date.now(),data:decorateSpcGeoJson(slide.kind,json)};cached.set(slide.layer,entry);
        }
        if(request!==serial)return;
        features=entry.data.features;kind=slide.kind;map.getSource('news-spc').setData(entry.data);makeLegend(legend,kind,features);
        const issue=features[0]?.properties?.issue||features[0]?.properties?.idp_filedate;
        status.textContent=features.length?`NOAA / SPC • ${issue?'Issued '+formatSpcTime(issue):'Updated '+new Date(entry.time).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`:`NOAA / SPC • No ${slide.label} risk areas delineated in the current product`;
        reset();
      }catch(error){if(request!==serial)return;status.textContent='SPC feed reconnecting. Open the official outlook for the latest product.';}
    }
    slot.querySelectorAll('[data-news-spc]').forEach(b=>b.addEventListener('click',()=>show(Number(b.dataset.newsSpc))));
    slot.querySelector('#newsSpcPrev').addEventListener('click',()=>show(index-1));slot.querySelector('#newsSpcNext').addEventListener('click',()=>show(index+1));
    slot.querySelector('#newsSpcPause').addEventListener('click',event=>{paused=!paused;event.currentTarget.setAttribute('aria-pressed',String(paused));event.currentTarget.textContent=paused?'Resume rotation':'Pause rotation';});
    slot.addEventListener('mouseenter',()=>hovered=true);slot.addEventListener('mouseleave',()=>hovered=false);
    slot.addEventListener('focusin',()=>focused=true);slot.addEventListener('focusout',event=>focused=slot.contains(event.relatedTarget));
    new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;},{rootMargin:'120px'}).observe(slot);
    setInterval(()=>{if(ready&&visible&&!document.hidden&&!paused&&!hovered&&!focused&&!matchMedia('(prefers-reduced-motion: reduce)').matches)show(index+1);},14000);
    try{
      if(!document.querySelector('link[data-news-mapbox]')){const css=document.createElement('link');css.rel='stylesheet';css.href='https://api.mapbox.com/mapbox-gl-js/v3.10.0/mapbox-gl.css';css.dataset.newsMapbox='';document.head.appendChild(css);}
      if(!window.MAPBOX_PUBLIC_TOKEN)await script('mapbox-token.js');
      if(!window.mapboxgl)await script('https://api.mapbox.com/mapbox-gl-js/v3.10.0/mapbox-gl.js');
      if(!window.MAPBOX_PUBLIC_TOKEN||!window.mapboxgl)throw new Error('Map assets reconnecting');
      mapboxgl.accessToken=window.MAPBOX_PUBLIC_TOKEN;
      map=new mapboxgl.Map({container:el,style:MAPBOX_STYLE,center:[-96.2,38.5],zoom:2.7,bearing:0,pitch:0,projection:'mercator',renderWorldCopies:false,dragRotate:false,pitchWithRotate:false,cooperativeGestures:true,attributionControl:true});
      el.appendChild(canvas);
      map.addControl(new mapboxgl.NavigationControl({showCompass:false}),'top-right');map.touchZoomRotate.disableRotation();
      map.on('load',()=>{
        ready=true;map.addSource('news-spc',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
        map.addLayer({id:'news-spc-hitbox',type:'fill',source:'news-spc',paint:{'fill-color':'#fff','fill-opacity':.001}});
        map.on('click','news-spc-hitbox',event=>{const p=event.features?.[0]?.properties;if(p)new mapboxgl.Popup({maxWidth:'250px'}).setLngLat(event.lngLat).setHTML(`<strong>${escapeHtml(p._zwxLabel||p.label2||p.label||'SPC Outlook')}</strong>${p.valid?'<br>Valid: '+escapeHtml(formatSpcTime(p.valid)):''}`).addTo(map);});
        reset();show(index);
      });
      ['move','zoom','resize'].forEach(event=>map.on(event,schedule));
      new ResizeObserver(reset).observe(el);
      map.on('error',()=>{if(!ready)status.textContent='Basemap reconnecting. Official SPC outlook links remain available.';});
    }catch(error){status.textContent='Map assets reconnecting. Open Maps & Models or the official SPC outlook.';}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
