#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import math
import os
import shutil
import time
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy.spatial import cKDTree
from scipy.interpolate import RegularGridInterpolator
from eccodes import (
    codes_get,
    codes_get_array,
    codes_get_long,
    codes_grib_new_from_file,
    codes_release,
)
from pyproj import CRS, Transformer
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
    service_base = SURFACE_URL.rsplit("/10/query", 1)[0]
    merged = {}

    # NOAA's surface_obs service is intentionally split into 6 scale bands.
    # Pull all of them once when the cached product is built; the browser will
    # reveal them progressively by zoom level.
    for layer in (10, 20, 30, 40, 50, 60):
        url = f"{service_base}/{layer}/query"
        offset = 0

        while True:
            params = {
                "where": "temperature IS NOT NULL",
                "outFields": (
                    "stationname,locationname,temperature,dewpoint,timeobs,"
                    "priority,winddir,windspeed,windgust,sealevelpress,"
                    "preschange,visibility,cloudcover,rawdata"
                ),
                "returnGeometry": "true",
                "outSR": "4326",
                "resultRecordCount": "2000",
                "resultOffset": str(offset),
                # Include surrounding Canada/Mexico/Caribbean like WeatherFront.
                "geometry": "-140,15,-55,60",
                "geometryType": "esriGeometryEnvelope",
                "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
                "f": "geojson",
            }

            try:
                raw = fetch_json(url, params=params, timeout=22).get("features", [])
            except Exception as exc:
                print(
                    f"Surface observation layer {layer} unavailable: {exc}",
                    flush=True,
                )
                break

            if not raw:
                break

            for feature in raw:
                coords = (feature.get("geometry") or {}).get("coordinates") or []
                props = feature.get("properties") or {}

                try:
                    lon = float(coords[0])
                    lat = float(coords[1])
                    temp = float(props.get("temperature"))
                except Exception:
                    continue

                if not (-80 <= temp <= 135):
                    continue

                station = str(
                    props.get("stationname") or
                    props.get("locationname") or
                    ""
                ).strip().upper()

                key = (
                    station,
                    round(lon, 3),
                    round(lat, 3),
                )

                try:
                    obs_time = float(props.get("timeobs") or 0)
                except Exception:
                    obs_time = 0.0

                try:
                    priority = float(props.get("priority") or 999)
                except Exception:
                    priority = 999.0

                props["_source_layer"] = layer
                candidate = (
                    lon,
                    lat,
                    temp,
                    props,
                    obs_time,
                    priority,
                )

                old = merged.get(key)

                if old is None:
                    merged[key] = candidate
                    continue

                # A station appearing in a coarser scale band should keep that
                # coarser layer so it appears earlier when zooming out.
                old_layer = int(old[3].get("_source_layer") or 60)
                use_candidate = False

                if layer < old_layer:
                    use_candidate = True
                elif layer == old_layer:
                    if obs_time > old[4]:
                        use_candidate = True
                    elif obs_time == old[4] and priority < old[5]:
                        use_candidate = True

                if use_candidate:
                    merged[key] = candidate

            if len(raw) < 2000:
                break

            offset += len(raw)

    out = [
        (lon, lat, temp, props)
        for lon, lat, temp, props, _, _ in merged.values()
    ]

    if len(out) < 2:
        raise RuntimeError("Not enough surface observations")

    print(
        f"Merged {len(out)} surface observations from NOAA scale bands 10-60",
        flush=True,
    )
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
    stops = [
        (-40, (241, 207, 204)),
        (-35, (236, 185, 200)),
        (-30, (219, 164, 195)),
        (-25, (202, 142, 191)),
        (-20, (186, 121, 186)),
        (-15, (169,  99, 181)),
        (-10, (153,  78, 176)),
        ( -5, (132,  55, 171)),
        (  0, (160,  61, 173)),
        (  5, (179, 119, 194)),
        ( 10, (198, 178, 216)),
        ( 15, (223, 237, 242)),
        ( 20, (161, 188, 223)),
        ( 25, ( 98, 141, 201)),
        ( 30, ( 26,  83, 178)),
        ( 35, ( 71, 118, 112)),
        ( 40, (150, 175, 139)),
        ( 45, (217, 223, 163)),
        ( 50, (238, 222, 155)),
        ( 55, (212, 181, 127)),
        ( 60, (187, 140,  99)),
        ( 65, (161,  98,  70)),
        ( 70, (130,  50,  38)),
        ( 75, (104,  10,  11)),
        ( 80, (107,  17,  24)),
        ( 85, (128,  40,  58)),
        ( 90, (157, 114, 108)),
        ( 95, (229, 212, 202)),
        (100, (208, 200, 193)),
        (105, (167, 163, 157)),
        (110, (120, 117, 114)),
        (115, ( 87,  86,  85)),
    ]

    if v <= stops[0][0]:
        return stops[0][1]
    if v >= stops[-1][0]:
        return stops[-1][1]

    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if a <= v <= b:
            q = (v - a) / (b - a)
            return tuple(
                int(round(ca[i] + (cb[i] - ca[i]) * q))
                for i in range(3)
            )

    return stops[-1][1]
def font(size):
    candidates=[
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf"]
    for path in candidates:
        if os.path.exists(path): return ImageFont.truetype(path,size)
    return ImageFont.load_default()

def render_temperature(states, obs):
    # Higher-resolution static product so zooming remains useful without
    # making the rest of the cached weather products larger.
    w, h = 1500, 960
    map_h = 845
    west, south, east, north = TEMP_BOUNDS

    # Dense-enough grid for the still image; the observation merge above
    # supplies significantly more stations than the old national-only layer.
    gw, gh = 500, 282
    lons = np.linspace(west, east, gw)
    lats = np.linspace(north, south, gh)
    gx, gy = np.meshgrid(lons, lats)

    samples = np.array(
        [[o[0] * math.cos(math.radians(o[1])), o[1]] for o in obs],
        dtype=np.float64,
    )
    values = np.array([o[2] for o in obs], dtype=np.float64)

    if len(samples) < 2:
        raise RuntimeError("Not enough surface observations")

    pts = np.column_stack([
        gx.ravel() * np.cos(np.radians(gy.ravel())),
        gy.ravel(),
    ])

    tree = cKDTree(samples)
    k = min(10, len(samples))
    dist, idx = tree.query(pts, k=k)

    if k == 1:
        dist = dist[:, None]
        idx = idx[:, None]

    weights = 1.0 / np.power(dist * dist + 0.055, 1.15)
    z = (weights * values[idx]).sum(axis=1) / weights.sum(axis=1)
    z = (np.round(z / 2.0) * 2.0).reshape(gh, gw)

    rgb = np.zeros((gh, gw, 3), dtype=np.uint8)
    for yy in range(gh):
        for xx in range(gw):
            rgb[yy, xx] = temp_color(float(z[yy, xx]))

    field = Image.fromarray(rgb, "RGB").resize(
        (w, map_h),
        Image.Resampling.BICUBIC,
    )

    draw = ImageDraw.Draw(field, "RGBA")

    # AGWX-style strong black state outlines.
    draw_states(
        draw,
        states,
        bounds=TEMP_BOUNDS,
        w=w,
        h=map_h,
        outline=(10, 8, 7, 245),
        width=3,
    )

    # More station labels than the previous renderer. Priority/newness still
    # control collisions, so the map stays readable.
    chosen = {}
    cell = 68

    for lon, lat, temp, props in obs:
        x, y = lonlat_xy(lon, lat, TEMP_BOUNDS, w, map_h)

        if not (18 < x < w - 18 and 18 < y < map_h - 18):
            continue

        key = (round(x / cell), round(y / cell))

        try:
            priority = float(props.get("priority") or 999)
        except Exception:
            priority = 999.0

        try:
            obs_time = float(props.get("timeobs") or 0)
        except Exception:
            obs_time = 0.0

        rank = (priority, -obs_time)
        old = chosen.get(key)

        if old is None or rank < old[0]:
            chosen[key] = (rank, x, y, temp)

    fnt = font(26)

    for _, x, y, temp in chosen.values():
        label = str(int(round(temp)))

        # Match the AGWX reference: warm/hot values yellow, cooler values dark.
        fill = (255, 242, 0, 255) if temp >= 74 else (18, 14, 11, 255)
        stroke = (
            (68, 20, 14, 245)
            if temp >= 74
            else (255, 243, 210, 215)
        )

        draw.text(
            (x, y),
            label,
            font=fnt,
            anchor="mm",
            fill=fill,
            stroke_width=3,
            stroke_fill=stroke,
        )

    # Put the map on a white legend panel, matching the supplied AGWX product.
    canvas = Image.new("RGB", (w, h), (250, 250, 250))
    canvas.paste(field, (0, 0))
    d = ImageDraw.Draw(canvas, "RGBA")

    x0, x1 = 360, w - 360
    y0, y1 = map_h + 18, map_h + 50

    for x in range(x0, x1 + 1):
        value = -40 + (x - x0) / max(1, (x1 - x0)) * 155
        d.line((x, y0, x, y1), fill=temp_color(value) + (255,))

    d.rectangle(
        (x0, y0, x1, y1),
        outline=(10, 10, 10, 255),
        width=2,
    )

    tick_font = font(12)
    for value in range(-40, 116, 5):
        x = x0 + (value + 40) / 155 * (x1 - x0)

        d.line(
            (x, y1, x, y1 + 5),
            fill=(20, 20, 20, 255),
            width=1,
        )
        d.text(
            (x, y1 + 7),
            str(value),
            font=tick_font,
            anchor="mt",
            fill=(12, 12, 12, 255),
        )

    d.text(
        ((x0 + x1) / 2, h - 14),
        "Temperature °F",
        font=font(22),
        anchor="ms",
        fill=(12, 12, 12, 255),
    )

    print(f"Plotted {len(chosen)} station labels on current-temperature image", flush=True)
    return canvas
def slippy_x(lon, zoom):
    n = 2 ** zoom
    return (lon + 180.0) / 360.0 * n

def slippy_y(lat, zoom):
    lat = max(-85.05112878, min(85.05112878, lat))
    n = 2 ** zoom
    r = math.radians(lat)
    return (1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n

def slippy_lon(x, zoom):
    return x / (2 ** zoom) * 360.0 - 180.0

def slippy_lat(y, zoom):
    n = 2 ** zoom
    return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))

RTMA_X_MIN_KM = -3271.147131
RTMA_X_MAX_KM = 2681.916449
RTMA_Y_MIN_KM = -263.797620
RTMA_Y_MAX_KM = 3789.568196
RTMA_NX = 2345
RTMA_NY = 1597

RTMA_CRS = CRS.from_proj4(
    "+proj=lcc +lat_1=25 +lat_0=25 +lon_0=-95 "
    "+R=6371200 +units=m +no_defs"
)
WGS84_CRS = CRS.from_epsg(4326)
RTMA_TO_WGS84 = Transformer.from_crs(
    RTMA_CRS,
    WGS84_CRS,
    always_xy=True,
)
WGS84_TO_RTMA = Transformer.from_crs(
    WGS84_CRS,
    RTMA_CRS,
    always_xy=True,
)

def rtma_candidate_times(hours_back=7):
    now = datetime.now(timezone.utc).replace(
        minute=0,
        second=0,
        microsecond=0,
    )

    # Operational RTMA has normal latency; start one hour behind UTC.
    start = now.timestamp() - 3600

    for offset in range(hours_back):
        yield datetime.fromtimestamp(
            start - offset * 3600,
            tz=timezone.utc,
        )

def fetch_latest_rtma_2m_temperature():
    last_error = None

    for valid_time in rtma_candidate_times():
        ymd = valid_time.strftime("%Y%m%d")
        hour = valid_time.strftime("%H")

        base = (
            "https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtma/prod/"
            f"rtma2p5.{ymd}/"
            f"rtma2p5.t{hour}z.2dvaranl_ndfd.grb2_wexp"
        )

        try:
            index_response = get(
                base + ".idx",
                timeout=15,
                attempts=1,
            )
            lines = index_response.text.splitlines()

            target_index = None

            for i, line in enumerate(lines):
                if ":TMP:2 m above ground:" in line:
                    target_index = i
                    break

            if target_index is None:
                raise RuntimeError("2-m TMP message not found in RTMA index")

            current_parts = lines[target_index].split(":")
            if len(current_parts) < 2:
                raise RuntimeError(
                    f"Unexpected RTMA index line: {lines[target_index]}"
                )

            # wgrib2 inventory format is:
            # message_number:byte_offset:metadata...
            # The SECOND field is the byte location in the GRIB2 file.
            start_byte = int(current_parts[1])

            if target_index + 1 < len(lines):
                next_parts = lines[target_index + 1].split(":")
                if len(next_parts) < 2:
                    raise RuntimeError(
                        f"Unexpected RTMA index line: "
                        f"{lines[target_index + 1]}"
                    )
                end_byte = int(next_parts[1]) - 1
                range_value = f"bytes={start_byte}-{end_byte}"
            else:
                range_value = f"bytes={start_byte}-"

            response = SESSION.get(
                base,
                headers={
                    "Range": range_value,
                    "User-Agent": UA,
                },
                timeout=25,
            )
            response.raise_for_status()

            if not response.content.startswith(b"GRIB"):
                raise RuntimeError(
                    f"RTMA byte-range response was not GRIB2 "
                    f"(status {response.status_code})"
                )

            print(
                f"Using RTMA 2-m temperature valid "
                f"{valid_time.isoformat()}",
                flush=True,
            )

            return response.content, valid_time

        except Exception as exc:
            last_error = exc

    raise RuntimeError(
        f"Could not locate recent RTMA 2-m temperature: {last_error}"
    )

def decode_rtma_temperature(grib_bytes):
    # ecCodes' codes_grib_new_from_file() requires a real file descriptor on
    # Windows. io.BytesIO does not provide fileno(), so write the one-message
    # GRIB2 byte-range response to a temporary file first.
    temp_path = None
    gid = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            suffix=".grb2",
            delete=False,
        ) as temp_file:
            temp_file.write(grib_bytes)
            temp_path = temp_file.name

        with open(temp_path, "rb") as handle:
            gid = codes_grib_new_from_file(handle)

            if gid is None:
                raise RuntimeError("ecCodes could not decode RTMA GRIB2")

            nx = int(codes_get_long(gid, "Nx"))
            ny = int(codes_get_long(gid, "Ny"))

            values = np.asarray(
                codes_get_array(gid, "values"),
                dtype=np.float64,
            )

            j_consecutive = int(
                codes_get_long(gid, "jPointsAreConsecutive")
            )
            i_negative = int(
                codes_get_long(gid, "iScansNegatively")
            )
            j_positive = int(
                codes_get_long(gid, "jScansPositively")
            )

            if j_consecutive:
                field = values.reshape((nx, ny)).T
            else:
                field = values.reshape((ny, nx))

            if i_negative:
                field = np.fliplr(field)

            if not j_positive:
                field = np.flipud(field)

            try:
                missing = float(codes_get(gid, "missingValue"))
                field[np.isclose(field, missing)] = np.nan
            except Exception:
                pass

            # Kelvin -> Fahrenheit.
            field = (field - 273.15) * 9.0 / 5.0 + 32.0

            x = np.linspace(
                RTMA_X_MIN_KM * 1000.0,
                RTMA_X_MAX_KM * 1000.0,
                nx,
            )
            y = np.linspace(
                RTMA_Y_MIN_KM * 1000.0,
                RTMA_Y_MAX_KM * 1000.0,
                ny,
            )

            print(
                f"Decoded RTMA grid {nx}x{ny} "
                f"({np.nanmin(field):.1f}F to {np.nanmax(field):.1f}F)",
                flush=True,
            )

            return x, y, field

    finally:
        if gid is not None:
            try:
                codes_release(gid)
            except Exception:
                pass

        if temp_path:
            try:
                os.remove(temp_path)
            except Exception:
                pass
def rtma_footprint_lonlat():
    corners_xy = [
        (RTMA_X_MIN_KM * 1000.0, RTMA_Y_MIN_KM * 1000.0),
        (RTMA_X_MAX_KM * 1000.0, RTMA_Y_MIN_KM * 1000.0),
        (RTMA_X_MAX_KM * 1000.0, RTMA_Y_MAX_KM * 1000.0),
        (RTMA_X_MIN_KM * 1000.0, RTMA_Y_MAX_KM * 1000.0),
    ]

    return [
        list(RTMA_TO_WGS84.transform(x, y))
        for x, y in corners_xy
    ]

def rgba_from_temperature_array(values):
    stops = np.array(
        [-40,-35,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,35,
         40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115],
        dtype=np.float64,
    )

    colors = np.array(
        [temp_color(float(value)) for value in stops],
        dtype=np.float64,
    )

    rgba = np.zeros(values.shape + (4,), dtype=np.uint8)
    finite = np.isfinite(values)

    if not np.any(finite):
        return rgba

    clipped = np.clip(values[finite], stops[0], stops[-1])

    for channel in range(3):
        rgba[..., channel][finite] = np.interp(
            clipped,
            stops,
            colors[:, channel],
        ).astype(np.uint8)

    rgba[..., 3][finite] = 255
    return rgba

def tile_lonlat_mesh(zoom, tile_x, tile_y, size=256):
    n = 2 ** zoom

    x_fraction = (
        tile_x + (np.arange(size, dtype=np.float64) + 0.5) / size
    ) / n
    y_fraction = (
        tile_y + (np.arange(size, dtype=np.float64) + 0.5) / size
    ) / n

    lon = x_fraction * 360.0 - 180.0
    mercator = math.pi * (1.0 - 2.0 * y_fraction)
    lat = np.degrees(np.arctan(np.sinh(mercator)))

    return np.meshgrid(lon, lat)

def render_rtma_temperature_tiles(out_root):
    grib_bytes, valid_time = fetch_latest_rtma_2m_temperature()
    x, y, temperature_f = decode_rtma_temperature(grib_bytes)

    interpolator = RegularGridInterpolator(
        (y, x),
        temperature_f,
        method="linear",
        bounds_error=False,
        fill_value=np.nan,
    )

    footprint = rtma_footprint_lonlat()
    lons = [point[0] for point in footprint]
    lats = [point[1] for point in footprint]

    west = min(lons)
    east = max(lons)
    south = min(lats)
    north = max(lats)

    tile_root = out_root / "temp-tiles"

    if tile_root.exists():
        shutil.rmtree(tile_root)

    tile_root.mkdir(parents=True, exist_ok=True)

    tile_size = 256
    min_zoom = 3
    max_zoom = 7
    tile_count = 0

    for zoom in range(min_zoom, max_zoom + 1):
        n = 2 ** zoom

        x0 = max(0, int(math.floor(slippy_x(west, zoom))))
        x1 = min(n - 1, int(math.floor(slippy_x(east, zoom))))
        y0 = max(0, int(math.floor(slippy_y(north, zoom))))
        y1 = min(n - 1, int(math.floor(slippy_y(south, zoom))))

        for tile_x in range(x0, x1 + 1):
            for tile_y in range(y0, y1 + 1):
                lon_grid, lat_grid = tile_lonlat_mesh(
                    zoom,
                    tile_x,
                    tile_y,
                    tile_size,
                )

                proj_x, proj_y = WGS84_TO_RTMA.transform(
                    lon_grid,
                    lat_grid,
                )

                points = np.column_stack([
                    np.asarray(proj_y).ravel(),
                    np.asarray(proj_x).ravel(),
                ])

                tile_values = interpolator(points).reshape(
                    tile_size,
                    tile_size,
                )

                rgba = rgba_from_temperature_array(tile_values)

                # Skip tiles that contain no RTMA coverage at all.
                if not np.any(rgba[..., 3]):
                    continue

                tile = Image.fromarray(rgba, "RGBA")
                tile_dir = tile_root / str(zoom) / str(tile_x)
                tile_dir.mkdir(parents=True, exist_ok=True)

                tile.save(
                    tile_dir / f"{tile_y}.webp",
                    "WEBP",
                    quality=88,
                    method=5,
                )
                tile_count += 1

    return {
        "valid_time": valid_time,
        "footprint": footprint,
        "bounds": [west, south, east, north],
        "tile_count": tile_count,
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
        "tile_size": tile_size,
    }

def simplify_ring_for_browser(ring, min_distance=0.025):
    out = []
    last = None
    threshold_sq = min_distance * min_distance

    for coord in ring:
        try:
            lon = float(coord[0])
            lat = float(coord[1])
        except Exception:
            continue

        if last is None:
            out.append([lon, lat])
            last = [lon, lat]
            continue

        dx = lon - last[0]
        dy = lat - last[1]

        if dx * dx + dy * dy >= threshold_sq:
            out.append([lon, lat])
            last = [lon, lat]

    if len(out) >= 3 and out[0] != out[-1]:
        out.append(out[0])

    return out

def simplified_state_geojson(states):
    features = []

    for feature in states:
        geometry = feature.get("geometry") or {}
        kind = geometry.get("type")
        coords = geometry.get("coordinates") or []

        if kind == "Polygon":
            simplified = [
                simplify_ring_for_browser(ring)
                for ring in coords
            ]
            simplified = [ring for ring in simplified if len(ring) >= 4]
            new_geometry = {
                "type": "Polygon",
                "coordinates": simplified,
            }

        elif kind == "MultiPolygon":
            polygons = []
            for polygon in coords:
                rings = [
                    simplify_ring_for_browser(ring)
                    for ring in polygon
                ]
                rings = [ring for ring in rings if len(ring) >= 4]
                if rings:
                    polygons.append(rings)

            new_geometry = {
                "type": "MultiPolygon",
                "coordinates": polygons,
            }

        else:
            continue

        features.append({
            "type": "Feature",
            "properties": feature.get("properties") or {},
            "geometry": new_geometry,
        })

    return {
        "type": "FeatureCollection",
        "features": features,
    }
def render_temperature_tile_field(states, obs):
    west, south, east, north = TEMP_BOUNDS

    # Web-Mercator-aligned source bitmap. Once built, every XYZ tile is only
    # a crop/resample operation; the browser never has to reproject it.
    source_w = 3072
    mercator_aspect = (
        (merc_y(north) - merc_y(south)) /
        math.radians(east - west)
    )
    source_h = max(1200, int(round(source_w * mercator_aspect)))

    grid_w = 768
    grid_h = max(
        320,
        int(round(grid_w * source_h / source_w))
    )

    lons = np.linspace(west, east, grid_w)
    merc_north = merc_y(north)
    merc_south = merc_y(south)
    merc_rows = np.linspace(merc_north, merc_south, grid_h)
    lats = np.degrees(
        2.0 * np.arctan(np.exp(merc_rows)) - math.pi / 2.0
    )

    gx, gy = np.meshgrid(lons, lats)

    samples = np.array(
        [[o[0] * math.cos(math.radians(o[1])), o[1]] for o in obs],
        dtype=np.float64,
    )
    values = np.array([o[2] for o in obs], dtype=np.float64)

    if len(samples) < 2:
        raise RuntimeError("Not enough surface observations for temperature tiles")

    points = np.column_stack([
        gx.ravel() * np.cos(np.radians(gy.ravel())),
        gy.ravel(),
    ])

    tree = cKDTree(samples)
    k = min(10, len(samples))
    dist, idx = tree.query(points, k=k)

    if k == 1:
        dist = dist[:, None]
        idx = idx[:, None]

    weights = 1.0 / np.power(dist * dist + 0.055, 1.15)
    z = (weights * values[idx]).sum(axis=1) / weights.sum(axis=1)
    z = (np.round(z / 2.0) * 2.0).reshape(grid_h, grid_w)

    rgb = np.zeros((grid_h, grid_w, 3), dtype=np.uint8)
    for yy in range(grid_h):
        for xx in range(grid_w):
            rgb[yy, xx] = temp_color(float(z[yy, xx]))

    field = Image.fromarray(rgb, "RGB").resize(
        (source_w, source_h),
        Image.Resampling.BICUBIC,
    ).convert("RGBA")

    draw = ImageDraw.Draw(field, "RGBA")
    draw_states(
        draw,
        states,
        bounds=TEMP_BOUNDS,
        w=source_w,
        h=source_h,
        outline=(8, 7, 6, 245),
        width=5,
        mercator=True,
    )

    return field

def temperature_station_geojson(obs):
    features = []

    for lon, lat, temp, props in obs:
        def number(name):
            try:
                value = float(props.get(name))
                return value if math.isfinite(value) else None
            except Exception:
                return None

        dew = number("dewpoint")
        winddir = number("winddir")
        windspeed = number("windspeed")
        windgust = number("windgust")
        pressure = number("sealevelpress")
        pressure_change = number("preschange")
        visibility = number("visibility")

        try:
            priority = float(props.get("priority") or 999)
        except Exception:
            priority = 999.0

        try:
            source_layer = int(props.get("_source_layer") or 60)
        except Exception:
            source_layer = 60

        if pressure is not None:
            pressure_code = f"{int(round(pressure * 10)) % 1000:03d}"
        else:
            pressure_code = ""

        if windspeed is not None:
            wind_bin = int(
                min(150, max(0, round(windspeed / 5.0) * 5))
            )
        else:
            wind_bin = 0

        station = str(
            props.get("stationname") or
            props.get("locationname") or
            ""
        )

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            },
            "properties": {
                "stationname": station,
                "locationname": str(props.get("locationname") or ""),
                "temperature": float(temp),
                "tempLabel": str(int(round(temp))),
                "dewpoint": dew,
                "dewLabel": "" if dew is None else str(int(round(dew))),
                "winddir": winddir,
                "windspeed": windspeed,
                "windgust": windgust,
                "windBin": wind_bin,
                "sealevelpress": pressure,
                "pressureCode": pressure_code,
                "preschange": pressure_change,
                "visibility": visibility,
                "cloudcover": str(props.get("cloudcover") or ""),
                "timeobs": props.get("timeobs"),
                "priority": priority,
                "sourceLayer": source_layer,
            },
        })

    features.sort(
        key=lambda feature: (
            int(feature["properties"].get("sourceLayer") or 60),
            float(feature["properties"].get("priority") or 999),
        )
    )

    return {
        "type": "FeatureCollection",
        "features": features,
    }
def render_temperature_tiles(states, obs, out_root):
    tile_root = out_root / "temp-tiles"

    try:
        rtma = render_rtma_temperature_tiles(out_root)
        source_name = "NOAA/NCEP RTMA 2-m Temperature"
        source_mode = "rtma"
    except Exception as exc:
        print(
            f"RTMA tile render failed; using station interpolation fallback: {exc}",
            flush=True,
        )

        # V64 fallback path.
        field = render_temperature_tile_field(states, obs)
        source_w, source_h = field.size
        west, south, east, north = TEMP_BOUNDS

        mercator_north = merc_y(north)
        mercator_south = merc_y(south)

        def source_x(lon):
            return (lon - west) / (east - west) * source_w

        def source_y(lat):
            return (
                (mercator_north - merc_y(lat)) /
                (mercator_north - mercator_south) *
                source_h
            )

        if tile_root.exists():
            shutil.rmtree(tile_root)

        tile_root.mkdir(parents=True, exist_ok=True)

        tile_size = 256
        min_zoom = 3
        max_zoom = 6
        tile_count = 0

        for zoom in range(min_zoom, max_zoom + 1):
            n = 2 ** zoom

            x0 = max(0, int(math.floor(slippy_x(west, zoom))))
            x1 = min(n - 1, int(math.floor(slippy_x(east, zoom))))
            y0 = max(0, int(math.floor(slippy_y(north, zoom))))
            y1 = min(n - 1, int(math.floor(slippy_y(south, zoom))))

            for x in range(x0, x1 + 1):
                lon_w = slippy_lon(x, zoom)
                lon_e = slippy_lon(x + 1, zoom)

                for y in range(y0, y1 + 1):
                    lat_n = slippy_lat(y, zoom)
                    lat_s = slippy_lat(y + 1, zoom)

                    crop_box = (
                        source_x(lon_w),
                        source_y(lat_n),
                        source_x(lon_e),
                        source_y(lat_s),
                    )

                    tile = field.transform(
                        (tile_size, tile_size),
                        Image.Transform.EXTENT,
                        crop_box,
                        resample=Image.Resampling.BICUBIC,
                        fillcolor=(0, 0, 0, 0),
                    )

                    tile_dir = tile_root / str(zoom) / str(x)
                    tile_dir.mkdir(parents=True, exist_ok=True)

                    tile.save(
                        tile_dir / f"{y}.webp",
                        "WEBP",
                        quality=86,
                        method=5,
                    )
                    tile_count += 1

        rtma = {
            "valid_time": datetime.now(timezone.utc),
            "footprint": [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
            ],
            "bounds": [west, south, east, north],
            "tile_count": tile_count,
            "min_zoom": min_zoom,
            "max_zoom": max_zoom,
            "tile_size": tile_size,
        }
        source_name = "Surface station interpolation fallback"
        source_mode = "interpolated"

    station_geojson = temperature_station_geojson(obs)

    with (tile_root / "stations.geojson").open(
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(
            station_geojson,
            handle,
            separators=(",", ":"),
        )

    with (tile_root / "states.geojson").open(
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(
            simplified_state_geojson(states),
            handle,
            separators=(",", ":"),
        )

    revision = int(time.time())

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "valid_time": rtma["valid_time"].isoformat(),
        "revision": revision,
        "source": source_name,
        "sourceMode": source_mode,
        "bounds": rtma["bounds"],
        "footprint": rtma["footprint"],
        "minzoom": rtma["min_zoom"],
        "maxzoom": rtma["max_zoom"],
        "tileSize": rtma["tile_size"],
        "tiles": "/weather-data/current-wx/temp-tiles/{z}/{x}/{y}.webp",
        "stations": "/weather-data/current-wx/temp-tiles/stations.geojson",
        "states": "/weather-data/current-wx/temp-tiles/states.geojson",
        "stationCount": len(station_geojson["features"]),
        "tileCount": rtma["tile_count"],
    }

    with (tile_root / "manifest.json").open(
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(manifest, handle, indent=2)

    print(
        f"Rendered {rtma['tile_count']} temperature tiles from "
        f"{source_name} and {len(station_geojson['features'])} stations",
        flush=True,
    )
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
        'noDataInterpretation':'esriNoDataMatchAny','mosaicRule':json.dumps({'mosaicMethod':'esriMosaicNone','where':"idp_subset = 'conus_QPE_72H'",'ascending':True,'mosaicOperation':'MT_FIRST'}),'renderingRule':json.dumps({'rasterFunction':'rft_72hr'}),'f':'image'}
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
            temperature_obs=fetch_surface_obs()
            img=render_temperature(ensure_states(),temperature_obs); name='current-temp.webp'
            render_temperature_tiles(ensure_states(),temperature_obs,out)
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
