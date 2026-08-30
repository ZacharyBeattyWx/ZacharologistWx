#!/usr/bin/env python3
"""Render a high-resolution hybrid NEXRAD mosaic for the Midwest test region.

The regional output is ONE numeric dBZ grid:
  1. Unidata national 1-km N0B fills every regional pixel as the fallback.
  2. Individual Level III N0B sites replace those values wherever native site data exists.
  3. The finished dBZ grid is colorized once with the Zacharologist Level-II palette.

This avoids stacking a coarse colored national image beneath a partially transparent
high-resolution colored image, which caused the visible big-pixel/small-pixel ghosting.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from pyproj import Geod
import requests
from metpy.io import Level3File

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

import render_mrms_mosaic as palette_renderer  # noqa: E402
import render_unidata_nexrad_mosaic as national_renderer  # noqa: E402
from unidata_gini_decode import decode_gini  # noqa: E402

DEFAULT_OUTPUT = REPO_ROOT / "unidata-nexrad-site-mosaic-output"
DEFAULT_BOUNDS = (-96.0, 34.5, -84.0, 43.5)  # west, south, east, north
DEFAULT_WIDTH = 4608
DEFAULT_SITES = ("EAX", "SGF", "LSX", "ILX", "PAH", "VWX", "IND", "LVX", "DVN")
HOSTS = ("https://tds.scigw.unidata.ucar.edu", "https://thredds.ucar.edu")
PRODUCT = "N0B"
NODATA = np.float32(-9999.0)
STAMP_RE = re.compile(r"(?P<date>\d{8})[_-](?P<time>\d{4,6})")
GEOD = Geod(ellps="WGS84")


@dataclass
class RadarSweep:
    site: str
    valid_time: datetime
    source_url: str
    lat: float
    lon: float
    max_range_km: float
    data: np.ndarray
    ray_lookup: np.ndarray


def dataset_timestamp(name: str) -> datetime:
    match = STAMP_RE.search(name)
    if not match:
        return datetime.min.replace(tzinfo=timezone.utc)
    clock = match.group("time")
    if len(clock) == 4:
        clock += "00"
    try:
        return datetime.strptime(match.group("date") + clock, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def catalog_urls(site: str, day: datetime):
    stamp = day.strftime("%Y%m%d")
    for host in HOSTS:
        yield host, f"{host}/thredds/catalog/nexrad/level3/{PRODUCT}/{site}/{stamp}/catalog.xml"


def discover_latest_site_file(session: requests.Session, site: str):
    now = datetime.now(timezone.utc)
    errors = []
    for day_offset in range(0, 3):
        day = now - timedelta(days=day_offset)
        for host, catalog_url in catalog_urls(site, day):
            try:
                response = session.get(catalog_url, timeout=15)
                if response.status_code != 200:
                    errors.append(f"{response.status_code} {catalog_url}")
                    continue
                root = ET.fromstring(response.content)
            except Exception as exc:
                errors.append(f"{catalog_url}: {exc}")
                continue

            found = []
            for elem in root.iter():
                if not elem.tag.endswith("dataset"):
                    continue
                name = elem.attrib.get("name", "")
                path = elem.attrib.get("urlPath", "")
                if not path or ".nids" not in (name + path).lower():
                    continue
                found.append((dataset_timestamp(name or path), name, path))
            if not found:
                continue
            found.sort(key=lambda item: item[0], reverse=True)
            valid_time, name, path = found[0]
            return {
                "site": site,
                "valid_time": valid_time,
                "name": name,
                "url": f"{host}/thredds/fileServer/{path.lstrip('/')}",
                "catalog_url": catalog_url,
            }

    raise RuntimeError(f"No recent {PRODUCT} data found for {site}. Last errors: {'; '.join(errors[-4:])}")


def find_radial_packet(value):
    if isinstance(value, dict):
        if all(key in value for key in ("data", "start_az", "end_az")):
            return value
        for child in value.values():
            found = find_radial_packet(child)
            if found is not None:
                return found
    elif isinstance(value, (list, tuple)):
        for child in value:
            found = find_radial_packet(child)
            if found is not None:
                return found
    return None


def build_ray_lookup(start_az, end_az, bins=3600):
    start = np.asarray(start_az, dtype=np.float32)
    end = np.asarray(end_az, dtype=np.float32)
    centers = np.mod(start + (np.mod(end - start + 540.0, 360.0) - 180.0) * 0.5, 360.0)
    sample_angles = np.arange(bins, dtype=np.float32) * (360.0 / bins)
    delta = np.abs(np.mod(centers[:, None] - sample_angles[None, :] + 180.0, 360.0) - 180.0)
    return np.argmin(delta, axis=0).astype(np.int32)


def load_site_sweep(session: requests.Session, site: str) -> RadarSweep:
    source = discover_latest_site_file(session, site)
    print(f"{site}: {source['name']}")
    response = session.get(source["url"], timeout=30)
    response.raise_for_status()
    nids = Level3File(BytesIO(response.content))
    packet = find_radial_packet(nids.sym_block)
    if packet is None:
        raise RuntimeError(f"{site}: no radial data packet found in {PRODUCT} file")

    mapped = np.ma.asarray(nids.map_data(packet["data"]), dtype=np.float32)
    data = np.asarray(mapped.filled(np.nan), dtype=np.float32)
    if data.ndim != 2:
        raise RuntimeError(f"{site}: unexpected mapped radar shape {data.shape}")

    ray_lookup = build_ray_lookup(packet["start_az"], packet["end_az"])
    max_range = float(getattr(nids, "max_range", 460.0))
    valid_time = source["valid_time"]
    if valid_time.year <= 1900:
        valid_time = nids.metadata.get("prod_time", datetime.now(timezone.utc))
        if valid_time.tzinfo is None:
            valid_time = valid_time.replace(tzinfo=timezone.utc)

    print(
        f"  {len(response.content)/1024:.1f} KiB | center={nids.lat:.3f},{nids.lon:.3f} | "
        f"rays={data.shape[0]} gates={data.shape[1]} max_range={max_range:.1f} km | "
        f"dBZ={np.nanmin(data):.1f}..{np.nanmax(data):.1f}"
    )
    return RadarSweep(
        site=site,
        valid_time=valid_time,
        source_url=source["url"],
        lat=float(nids.lat),
        lon=float(nids.lon),
        max_range_km=max_range,
        data=data,
        ray_lookup=ray_lookup,
    )


def load_national_fallback(session: requests.Session, bounds, width: int):
    print("Loading national N0B fallback for the same regional grid...")
    source = national_renderer.discover_latest_gini(session, "n0b")
    print(f"National: {source['dataset_name']}")
    response = session.get(source["file_url"], timeout=60)
    response.raise_for_status()
    gini = decode_gini(response.content)
    dbz = national_renderer.reproject_gini_to_lonlat(gini, "N0B", bounds, width)
    valid_time = source["timestamp"]
    if valid_time.year <= 1900:
        valid_time = gini.prod_desc.datetime.replace(tzinfo=timezone.utc)
    print(f"  fallback grid={dbz.shape[1]}x{dbz.shape[0]} valid={valid_time.isoformat()}")
    return dbz, source, valid_time


def sample_mosaic(sweeps: list[RadarSweep], bounds, width: int) -> np.ndarray:
    west, south, east, north = map(float, bounds)
    width = max(512, int(width))
    height = max(256, int(round(width * (north - south) / (east - west))))
    lon_axis = np.linspace(west, east, width, dtype=np.float64)
    lat_axis = np.linspace(north, south, height, dtype=np.float64)
    output = np.full((height, width), NODATA, dtype=np.float32)

    chunk_rows = 96
    for row0 in range(0, height, chunk_rows):
        row1 = min(height, row0 + chunk_rows)
        lats = lat_axis[row0:row1]
        lon_grid, lat_grid = np.meshgrid(lon_axis, lats)
        chunk_dbz = np.full(lon_grid.shape, NODATA, dtype=np.float32)
        best_distance = np.full(lon_grid.shape, np.inf, dtype=np.float64)

        for sweep in sweeps:
            radar_lon = np.full(lon_grid.shape, sweep.lon, dtype=np.float64)
            radar_lat = np.full(lat_grid.shape, sweep.lat, dtype=np.float64)
            forward_az, _, distance_m = GEOD.inv(radar_lon, radar_lat, lon_grid, lat_grid)
            distance_km = distance_m / 1000.0
            in_range = np.isfinite(distance_km) & (distance_km >= 0.0) & (distance_km <= sweep.max_range_km)
            if not np.any(in_range):
                continue

            bearing = np.mod(forward_az, 360.0)
            az_bin = np.mod(
                np.rint(bearing * (len(sweep.ray_lookup) / 360.0)).astype(np.int32),
                len(sweep.ray_lookup),
            )
            ray_index = sweep.ray_lookup[az_bin]
            gate_count = sweep.data.shape[1]
            gate_index = np.floor(distance_km / sweep.max_range_km * gate_count).astype(np.int32)
            gate_index = np.clip(gate_index, 0, gate_count - 1)
            sampled = sweep.data[ray_index, gate_index]
            valid = in_range & np.isfinite(sampled)

            # Nearest valid site wins in overlap zones. This avoids max-dBZ seam
            # inflation and normally favors the radar with the best spatial sampling.
            use = valid & (distance_km < best_distance)
            chunk_dbz[use] = sampled[use]
            best_distance[use] = distance_km[use]

        output[row0:row1] = chunk_dbz
        print(f"Site mosaic rows {row1}/{height}", end="\r", flush=True)

    print()
    return output


def render(args):
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    sites = tuple(site.strip().upper().lstrip("K") for site in args.sites.split(",") if site.strip())
    bounds = tuple(map(float, args.bounds))

    session = requests.Session()
    session.headers.update({"User-Agent": "ZacharologistWx/NEXRAD-hybrid-detail-test"})

    national_dbz, national_source, national_time = load_national_fallback(session, bounds, args.width)

    sweeps = []
    failures = []
    print(f"Loading {PRODUCT} from {len(sites)} radar sites...")
    for site in sites:
        try:
            sweeps.append(load_site_sweep(session, site))
        except Exception as exc:
            failures.append({"site": site, "error": str(exc)})
            print(f"  WARNING {site}: {exc}")

    if len(sweeps) < 2:
        raise RuntimeError(f"Need at least two working radar sites; got {len(sweeps)}")

    print(f"Building native-detail site grid from {len(sweeps)} sites...")
    site_dbz = sample_mosaic(sweeps, bounds, args.width)
    if site_dbz.shape != national_dbz.shape:
        raise RuntimeError(
            f"National/site grid mismatch: national={national_dbz.shape}, site={site_dbz.shape}"
        )

    # This is the key: merge numeric reflectivity FIRST, then colorize ONCE.
    combined_dbz = np.array(national_dbz, copy=True)
    site_valid = np.isfinite(site_dbz) & (site_dbz > -9000)
    combined_dbz[site_valid] = site_dbz[site_valid]

    valid = np.isfinite(combined_dbz) & (combined_dbz > -9000)
    if not np.any(valid):
        raise RuntimeError("Hybrid regional mosaic produced no valid radar pixels")

    replaced = int(np.count_nonzero(site_valid))
    total = int(site_valid.size)
    replaced_pct = 100.0 * replaced / max(1, total)
    print(
        f"Hybrid grid: {combined_dbz.shape[1]}x{combined_dbz.shape[0]} | "
        f"dBZ={float(np.nanmin(combined_dbz[valid])):.1f}..{float(np.nanmax(combined_dbz[valid])):.1f}"
    )
    print(
        f"Native site replacement: {replaced:,}/{total:,} pixels "
        f"({replaced_pct:.1f}%) | national N0B fills the remainder"
    )

    rgba = palette_renderer.colorize_dbz_grid_for_tiles(combined_dbz)
    image_path = output_dir / "desktop.webp"
    Image.fromarray(rgba, mode="RGBA").save(image_path, "WEBP", lossless=True, method=4)

    newest = max(s.valid_time for s in sweeps)
    oldest = min(s.valid_time for s in sweeps)
    manifest = {
        "revision": int(datetime.now(timezone.utc).timestamp()),
        "source": "Hybrid Unidata NEXRAD: national N0B fallback + individual Level III N0B replacement",
        "product": PRODUCT,
        "valid_time": newest.isoformat(),
        "oldest_site_time": oldest.isoformat(),
        "national_valid_time": national_time.isoformat(),
        "national_dataset": national_source["dataset_name"],
        "national_source_url": national_source["file_url"],
        "image": "desktop.webp",
        "imageWidth": int(combined_dbz.shape[1]),
        "imageHeight": int(combined_dbz.shape[0]),
        "bounds": list(bounds),
        "mosaicMethod": "national N0B fallback; nearest valid individual N0B site replaces fallback before colorization",
        "nativeReplacementPixels": replaced,
        "nativeReplacementPercent": round(replaced_pct, 3),
        "colorOwner": "Zacharologist Level II palette renderer",
        "sites": [
            {
                "site": sweep.site,
                "lat": sweep.lat,
                "lon": sweep.lon,
                "valid_time": sweep.valid_time.isoformat(),
                "max_range_km": sweep.max_range_km,
                "rays": int(sweep.data.shape[0]),
                "gates": int(sweep.data.shape[1]),
                "sourceUrl": sweep.source_url,
            }
            for sweep in sweeps
        ],
        "failures": failures,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {image_path}")
    print(f"Wrote {output_dir / 'manifest.json'}")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    parser.add_argument("--sites", default=",".join(DEFAULT_SITES))
    parser.add_argument(
        "--bounds",
        type=float,
        nargs=4,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        default=DEFAULT_BOUNDS,
    )
    return parser.parse_args()


if __name__ == "__main__":
    render(parse_args())
