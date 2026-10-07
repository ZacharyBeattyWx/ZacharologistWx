"""Independent, bounded mesoscale publishing with per-scan georeferencing."""
import hashlib
import json
import os
import re
from datetime import timedelta

import numpy as np
from netCDF4 import Dataset
from pyproj import Transformer

import satellite_truecolor_publisher as abi

SOURCE_RE = re.compile(r"RadM(?P<sector>[12])-M\dC(?P<channel>\d{2})_G\d+_s(?P<scan>\d{11})")
PRODUCTS = {"true-color": ("01", "02", "03", "13"), "13": ("13",), "02": ("02",)}
MAX_HISTORY_FRAMES = 60
HISTORY_WINDOW_MINUTES = 65


def scan_geometry(path):
    with Dataset(path) as dataset:
        crs, h = abi.projection_from_dataset(dataset)
        x = np.asarray(dataset.variables["x"][:], dtype=float) * h
        y = np.asarray(dataset.variables["y"][:], dtype=float) * h
    if len(x) < 2 or len(y) < 2:
        raise ValueError("Mesoscale scan has no coordinate grid")
    edges = [min(x)-abs(x[1]-x[0])/2, min(y)-abs(y[1]-y[0])/2,
             max(x)+abs(x[1]-x[0])/2, max(y)+abs(y[1]-y[0])/2]
    # Densify all four edges; extrema of a curved footprint need not be corners.
    xs = np.linspace(edges[0], edges[2], 129)
    ys = np.linspace(edges[1], edges[3], 129)
    px = np.concatenate((xs, xs, np.full(129, edges[0]), np.full(129, edges[2])))
    py = np.concatenate((np.full(129, edges[1]), np.full(129, edges[3]), ys, ys))
    lon, lat = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform(px, py)
    valid = np.isfinite(lon) & np.isfinite(lat)
    if not valid.all() or np.ptp(lon) > 100 or np.max(np.abs(lat)) >= 85:
        raise ValueError("Mesoscale footprint crosses unsupported limb, pole or dateline")
    bbox = [float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat))]
    identity = json.dumps([crs.to_string(), [round(v, -2) for v in edges]])
    return bbox, hashlib.sha256(identity.encode()).hexdigest()[:16]


def list_scans(bucket, sector, now):
    grouped = {}
    for offset in (0, 1, 2):
        hour = now-timedelta(hours=offset)
        prefix = f"ABI-L1b-RadM/{hour:%Y/%j/%H}/"
        for page in abi.SOURCE_S3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                match = SOURCE_RE.search(obj["Key"])
                if not match or int(match["sector"]) != sector or not obj["Key"].endswith(".nc"):
                    continue
                scan, channel = match["scan"], match["channel"]
                if channel not in PRODUCTS["true-color"]:
                    continue
                group = grouped.setdefault(scan, {"scan": scan, "time": abi.parse_scan(scan), "channels": {}})
                group["channels"][channel] = max(group["channels"].get(channel, ""), obj["Key"])
    return sorted((g for g in grouped.values() if all(c in g["channels"] for c in PRODUCTS["true-color"])
                   and now-timedelta(minutes=HISTORY_WINDOW_MINUTES) <= g["time"] <= now), key=lambda g: g["time"], reverse=True)


def render_band(spec, group, path, channel):
    crs = abi.source_crs_from_path(path)
    gx, gy, width, height = abi.output_grid(spec, crs)
    values = abi.read_brightness_temperature(path, gx, gy) if channel == "13" else abi.read_reflectance(path, gx, gy)
    sampled = abi.sample_grid(values, gx, gy)
    finite = np.isfinite(sampled)
    if channel == "13":
        rgb, finite = abi.clean_ir_rgb(sampled)
    else:
        gray = np.sqrt(np.clip(sampled, 0, 1))
        rgb = np.repeat(gray[..., None], 3, axis=2)
    payload, width, height = abi.encode_webp(rgb, finite)
    key = abi.frame_key(spec, group["time"])
    abi.TARGET_S3.put_object(Bucket=abi.TARGET_BUCKET, Key=key, Body=payload,
                             ContentType="image/webp", CacheControl="public,max-age=31536000,immutable")
    return {"scan": group["scan"], "time": abi.iso_z(group["time"]),
            "path": key[len(abi.TARGET_PREFIX)+1:], "width": width, "height": height}


def process_sector(platform, satellite, bucket, sector, now):
    root = f"{platform.lower()}/meso-{sector}"
    specs = {product: {"platform": platform, "satellite": satellite, "source_bucket": bucket,
             "source_product": "ABI-L1b-RadM", "prefix": f"{root}/{product}", "sector": f"M{sector}",
             "output_width": 1400, "c02_stride": 1, "render_version": 1, "night_channel": "13",
             "dehaze_floor": .035} for product in PRODUCTS}
    existing = {product: abi.read_manifest(spec) for product, spec in specs.items()}
    frames = {product: list(existing[product].get("frames", [])) for product in PRODUCTS}
    checked = {product: set(existing[product].get("checkedScans", [])) for product in PRODUCTS}
    budget = min(2, max(1, int(os.getenv("MESOSCALE_MAX_NEW_SCANS", "2"))))
    attempted = 0
    for group in list_scans(bucket, sector, now):
        missing = [product for product in PRODUCTS if group["scan"] not in checked[product] and not any(f.get("scan") == group["scan"] for f in frames[product])]
        if not missing:
            continue
        if attempted >= budget:
            break
        attempted += 1
        cache = {}
        try:
            for channel in set(c for product in missing for c in PRODUCTS[product]):
                cache[(bucket, group["channels"][channel])] = abi.download_source(bucket, group["channels"][channel], f"-M{sector}-C{channel}.nc")
            reference = cache[(bucket, group["channels"][PRODUCTS[missing[0]][0]])]
            bbox, geometry = scan_geometry(reference)
            for product in missing:
                spec = dict(specs[product], bbox=bbox)
                frame = abi.render_scan(spec, group, source_cache=cache) if product == "true-color" else render_band(spec, group, cache[(bucket, group["channels"][product])], product)
                if frame:
                    frames[product].append(dict(frame, bbox=bbox, geometry=geometry))
                    checked[product].add(group["scan"])
        finally:
            for path in cache.values():
                try:
                    os.unlink(path)
                except OSError:
                    pass
    counts = {}
    for product, spec in specs.items():
        ordered = sorted({f["scan"]: f for f in frames[product]}.values(), key=lambda f: f["time"])
        if not ordered:
            continue
        geometry = ordered[-1]["geometry"]
        kept = [f for f in ordered if f["geometry"] == geometry
                and now-timedelta(minutes=HISTORY_WINDOW_MINUTES) <= abi.datetime.fromisoformat(f["time"].replace("Z", "+00:00"))][-MAX_HISTORY_FRAMES:]
        output = {"version": 1, "projection": "EPSG:3857", "product": product, "platform": platform,
                  "sector": f"M{sector}", "generated": abi.iso_z(now), "frames": kept, "cadenceMinutes": 1,
                  "checkedScans": sorted(checked[product])[-96:]}
        abi.TARGET_S3.put_object(Bucket=abi.TARGET_BUCKET, Key=abi.manifest_key(spec),
                                 Body=json.dumps(output, separators=(",", ":")).encode(),
                                 ContentType="application/json", CacheControl="public,max-age=20")
        retained = {f["path"] for f in kept}
        obsolete = [f for f in ordered if f["path"] not in retained]
        # The manifest is committed before old, unreferenced frames are removed.
        for frame in obsolete:
            key = f"{abi.TARGET_PREFIX}/{frame['path']}"
            if key.startswith(f"{abi.TARGET_PREFIX}/{root}/{product}/frames/"):
                abi.TARGET_S3.delete_object(Bucket=abi.TARGET_BUCKET, Key=key)
        counts[product] = len(kept)
    return {"platform": platform, "sector": sector, "attempted": attempted, "frames": counts}


def lambda_handler(event, context):
    now = abi.utcnow()
    results = []
    for platform in os.getenv("MESOSCALE_PLATFORMS", "East").split(","):
        platform = platform.strip()
        if platform not in ("East", "West"):
            raise ValueError("MESOSCALE_PLATFORMS must be East and/or West")
        satellite = "GOES-19" if platform == "East" else "GOES-18"
        bucket = os.getenv(f"SATELLITE_{platform.upper()}_BUCKET", "noaa-goes19" if platform == "East" else "noaa-goes18")
        for sector in (1, 2):
            if context and context.get_remaining_time_in_millis() < 30000:
                break
            results.append(process_sector(platform, satellite, bucket, sector, now))
    return {"statusCode": 200, "results": results}
