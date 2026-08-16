#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy.spatial import cKDTree

UA = "ZacharologistWx/1.0 weather preview renderer (contact: zacharologistwx.com)"
OUT_W = 930
OUT_H = 600
LONLAT_BOUNDS = (-127.566871, 21.903974, -66.475331, 50.341849)
TEMP_BOUNDS = (-130.0, 20.0, -64.0, 53.5)
MERCATOR_BBOX = (-14200679.12, 2500000.0, -7400000.0, 6505689.94)

SURFACE_URL = "https://mapservices.weather.noaa.gov/vector/rest/services/obs/surface_obs/MapServer/10/query"
STATE_URL = "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/3/query"
HAZARD_META_URL = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1"
HAZARD_GEO_URL = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/FeatureServer/1/query"
MRMS_URL = "https://mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer/exportImage"
RADAR_URL = "https://radar.weather.gov/ridge/standard/CONUS-LARGE_0.gif"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA, "Accept": "*/*"})

def get(url: str, *, params=None, timeout=20, attempts=3) -> requests.Response:
    last = None
    for attempt in range(attempts):
        try:
            r = SESSION.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            return r
        except Exception as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(1.1 * (attempt + 1))
    raise RuntimeError(f"GET failed for {url}: {last}")

def fetch_json(url: str, *, params=None, timeout=20):
    return get(url, params=params, timeout=timeout).json()

def fetch_states():
    return fetch_json(STATE_URL, params={
        "where":"1=1","outFields":"name","returnGeometry":"true",
        "outSR":"4326","f":"geojson"
    }, timeout=18).get("features", [])

def fetch_surface_obs():
    params = {
        "where":"temperature IS NOT NULL",
        "outFields":"stationname,locationname,temperature,dewpoint,timeobs,priority",
        "returnGeometry":"true","outSR":"4326","resultRecordCount":"2000",
        "geometry":"-125.5,23.5,-66.0,50.2","geometryType":"esriGeometryEnvelope",
        "inSR":"4326","spatialRel":"esriSpatialRelIntersects","f":"geojson"
    }
    raw = fetch_json(SURFACE_URL, params=params, timeout=18).get("features", [])
    out=[]
    for f in raw:
        c=(f.get("geometry") or {}).get("coordinates") or []
        p=f.get("properties") or {}
        try: lon,lat=float(c[0]),float(c[1]); t=float(p.get("temperature"))
        except Exception: continue
        if -80 <= t <= 135:
            out.append((lon,lat,t,p))
    return out

def lonlat_xy(lon, lat, bounds, w, h):
    west,south,east,north=bounds
    return ((lon-west)/(east-west)*(w-1), (north-lat)/(north-south)*(h-1))

def merc_y(lat):
    lat=max(-85.05112878,min(85.05112878,lat))
    return math.log(math.tan(math.pi/4 + math.radians(lat)/2))

def lonlat_xy_mercator(lon, lat, bounds, w, h):
    west,south,east,north=bounds
    x=(lon-west)/(east-west)*(w-1)
    yn,ys=merc_y(north),merc_y(south)
    y=(yn-merc_y(lat))/(yn-ys)*(h-1)
    return x,y

def iter_rings(geometry):
    if not geometry: return
    typ=geometry.get("type"); coords=geometry.get("coordinates") or []
    if typ=="Polygon":
        for ring in coords: yield ring
    elif typ=="MultiPolygon":
        for poly in coords:
            for ring in poly: yield ring

def draw_states(draw, states, *, bounds, w, h, fill=None, outline=(20,20,18,235), width=2, mercator=False):
    projector=lonlat_xy_mercator if mercator else lonlat_xy
    for feature in states:
        geom=feature.get("geometry") or {}
        for ring in iter_rings(geom):
            pts=[]
            for coord in ring:
                try: pts.append(projector(float(coord[0]),float(coord[1]),bounds,w,h))
                except Exception: pass
            if len(pts)>=3:
                if fill is not None: draw.polygon(pts, fill=fill)
                draw.line(pts+[pts[0]], fill=outline, width=width, joint="curve")

def temp_color(v):
    stops=[
        (-40,(205,219,198)),(-20,(217,231,205)),(0,(238,237,194)),(20,(255,246,169)),
        (35,(244,225,155)),(45,(230,208,143)),(55,(214,184,124)),(65,(195,150,101)),
        (72,(178,115,82)),(78,(161,78,65)),(84,(145,52,51)),(90,(130,34,41)),
        (96,(119,25,45)),(102,(116,25,59)),(110,(147,51,104)),(120,(178,76,137))]
    if v<=stops[0][0]: return stops[0][1]
    if v>=stops[-1][0]: return stops[-1][1]
    for (a,ca),(b,cb) in zip(stops,stops[1:]):
        if a<=v<=b:
            q=(v-a)/(b-a)
            return tuple(int(ca[i]+(cb[i]-ca[i])*q) for i in range(3))
    return (210,196,157)

def font(size):
    candidates=[
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf"]
    for path in candidates:
        if os.path.exists(path): return ImageFont.truetype(path,size)
    return ImageFont.load_default()

def render_temperature(states, obs):
    w,h=OUT_W,OUT_H
    west,south,east,north=TEMP_BOUNDS
    # Compute a coarse analysis and upscale; this is fast and visually smooth.
    gw,gh=310,168
    lons=np.linspace(west,east,gw)
    lats=np.linspace(north,south,gh)
    gx,gy=np.meshgrid(lons,lats)
    samples=np.array([[o[0]*math.cos(math.radians(o[1])),o[1]] for o in obs],dtype=np.float64)
    values=np.array([o[2] for o in obs],dtype=np.float64)
    if len(samples)<2: raise RuntimeError("Not enough surface observations")
    pts=np.column_stack([(gx.ravel()*np.cos(np.radians(gy.ravel()))),gy.ravel()])
    tree=cKDTree(samples)
    k=min(8,len(samples))
    dist,idx=tree.query(pts,k=k)
    if k==1:
        dist=dist[:,None]; idx=idx[:,None]
    weights=1.0/np.power(dist*dist+0.055,1.15)
    z=(weights*values[idx]).sum(axis=1)/weights.sum(axis=1)
    z=(np.round(z/2.0)*2.0).reshape(gh,gw)
    rgb=np.zeros((gh,gw,3),dtype=np.uint8)
    for yy in range(gh):
        for xx in range(gw): rgb[yy,xx]=temp_color(float(z[yy,xx]))
    field=Image.fromarray(rgb,'RGB').resize((w,h),Image.Resampling.BICUBIC)
    d=ImageDraw.Draw(field,'RGBA')
    draw_states(d,states,bounds=TEMP_BOUNDS,w=w,h=h,outline=(20,15,12,235),width=2)
    # Declutter station labels into screen cells.
    chosen={}
    cell=62
    for lon,lat,t,p in obs:
        x,y=lonlat_xy(lon,lat,TEMP_BOUNDS,w,h)
        if not (18<x<w-18 and 18<y<h-46): continue
        key=(round(x/cell),round(y/cell))
        priority=float(p.get('priority') or 999)
        old=chosen.get(key)
        if old is None or priority < old[0]: chosen[key]=(priority,x,y,t)
    fnt=font(20)
    for _,x,y,t in chosen.values():
        label=str(int(round(t)))
        fill=(255,242,0,255) if t>=74 else (24,18,13,255)
        stroke=(73,25,16,235) if t>=74 else (255,241,206,200)
        d.text((x,y),label,font=fnt,anchor='mm',fill=fill,stroke_width=2,stroke_fill=stroke)
    # Bottom legend
    x0,x1=35,w-35; y0,y1=h-27,h-11
    for x in range(x0,x1):
        t=20+(x-x0)/(x1-x0)*80
        d.line((x,y0,x,y1),fill=temp_color(t)+(255,))
    d.rectangle((x0,y0,x1,y1),outline=(15,15,15,230),width=1)
    lf=font(14)
    for t in (20,40,60,80,100):
        x=x0+(t-20)/80*(x1-x0)
        d.text((x,y0+8),f"{t}°",font=lf,anchor='mm',fill=(15,15,15,255),stroke_width=1,stroke_fill=(255,255,255,180))
    return field

def renderer_lookup(meta):
    renderer=((meta.get('drawingInfo') or {}).get('renderer') or {})
    fields=[renderer.get('field1'),renderer.get('field2'),renderer.get('field3')]
    fields=[f for f in fields if f]
    delim=renderer.get('fieldDelimiter') or ','
    lookup={}
    for info in renderer.get('uniqueValueInfos') or []:
        symbol=info.get('symbol') or {}; label=str(info.get('label') or info.get('value') or '')
        color=symbol.get('color') or [148,163,184,100]
        outline=(symbol.get('outline') or {}).get('color') or [240,240,240,220]
        low=label.lower()
        alpha=.58 if 'warning' in low else .30 if 'watch' in low else .09 if 'advisory' in low else .06
        lookup[str(info.get('value'))]=(tuple(color[:3])+(int(255*alpha),),tuple(outline[:3])+(230,),fields,delim)
    return lookup,renderer

def render_hazards(states):
    meta=fetch_json(HAZARD_META_URL,params={'f':'json'},timeout=18)
    geo=fetch_json(HAZARD_GEO_URL,params={'where':'1=1','outFields':'*','returnGeometry':'true','outSR':'4326','f':'geojson'},timeout=25)
    lookup,renderer=renderer_lookup(meta)
    img=Image.new('RGBA',(OUT_W,OUT_H),(28,44,71,255)); d=ImageDraw.Draw(img,'RGBA')
    draw_states(d,states,bounds=LONLAT_BOUNDS,w=OUT_W,h=OUT_H,fill=(103,103,103,255),outline=(210,214,218,220),width=2,mercator=True)
    fields=[renderer.get('field1'),renderer.get('field2'),renderer.get('field3')]; fields=[f for f in fields if f]
    delim=renderer.get('fieldDelimiter') or ','
    for feature in geo.get('features') or []:
        p=feature.get('properties') or {}; key=delim.join(str(p.get(f,'')) for f in fields)
        style=lookup.get(key)
        if style: fill,outline,_,_=style
        else: fill,outline=(180,180,180,35),(235,235,235,150)
        for ring in iter_rings(feature.get('geometry') or {}):
            pts=[]
            for c in ring:
                try: pts.append(lonlat_xy_mercator(float(c[0]),float(c[1]),LONLAT_BOUNDS,OUT_W,OUT_H))
                except Exception: pass
            if len(pts)>=3:
                d.polygon(pts,fill=fill)
                d.line(pts+[pts[0]],fill=outline,width=2,joint='curve')
    return img.convert('RGB')

def base_state_map(states, *, light=False):
    bg=(237,245,247,255) if light else (28,44,71,255)
    land=(244,246,245,255) if light else (103,103,103,255)
    line=(198,80,80,190) if light else (214,218,222,220)
    img=Image.new('RGBA',(OUT_W,OUT_H),bg); d=ImageDraw.Draw(img,'RGBA')
    draw_states(d,states,bounds=LONLAT_BOUNDS,w=OUT_W,h=OUT_H,fill=land,outline=line,width=1 if light else 2,mercator=True)
    return img

def fetch_mrms():
    params={
        'bbox':','.join(str(v) for v in MERCATOR_BBOX),'bboxSR':'3857','imageSR':'3857',
        'size':f'{OUT_W},{OUT_H}','format':'png32','transparent':'true','noData':'-3',
        'noDataInterpretation':'esriNoDataMatchAny','renderingRule':json.dumps({'rasterFunction':'rft_72hr'}),'f':'image'}
    return Image.open(io.BytesIO(get(MRMS_URL,params=params,timeout=30).content)).convert('RGBA')

def render_mrms(states):
    base=base_state_map(states,light=False)
    overlay=fetch_mrms().resize((OUT_W,OUT_H),Image.Resampling.BILINEAR)
    return Image.alpha_composite(base,overlay).convert('RGB')

def render_radar():
    data=get(RADAR_URL,timeout=25).content
    src=Image.open(io.BytesIO(data)).convert('RGB')
    canvas=Image.new('RGB',(OUT_W,OUT_H),(239,245,247))
    fit=ImageOps.contain(src,(OUT_W,OUT_H),Image.Resampling.LANCZOS)
    canvas.paste(fit,((OUT_W-fit.width)//2,(OUT_H-fit.height)//2))
    return canvas

def save_webp(img,path):
    path.parent.mkdir(parents=True,exist_ok=True)
    img.save(path,'WEBP',quality=82,method=6)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--output',default='weather-data/current-wx')
    ap.add_argument('--only',choices=['temperature','hazards','mrms','radar'])
    args=ap.parse_args()
    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    products={}
    states=None
    def ensure_states():
        nonlocal states
        if states is None: states=fetch_states()
        return states
    targets=[args.only] if args.only else ['temperature','hazards','mrms','radar']
    for target in targets:
        print(f'Rendering {target}...',flush=True)
        if target=='temperature':
            img=render_temperature(ensure_states(),fetch_surface_obs()); name='current-temp.webp'
        elif target=='hazards':
            img=render_hazards(ensure_states()); name='current-hazards.webp'
        elif target=='mrms':
            img=render_mrms(ensure_states()); name='mrms-72h.webp'
        else:
            img=render_radar(); name='conus-radar.webp'
        save_webp(img,out/name)
        products[target]={'file':name,'bytes':(out/name).stat().st_size}
    now=datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    manifest_path=out/'manifest.json'
    existing={}
    if manifest_path.exists():
        try: existing=json.loads(manifest_path.read_text(encoding='utf-8'))
        except Exception: pass
    all_products=existing.get('products',{})
    all_products.update(products)
    manifest={'schemaVersion':1,'generatedAt':now,'status':'ok','products':all_products}
    manifest_path.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(f'Wrote {out} at {now}')

if __name__=='__main__': main()
