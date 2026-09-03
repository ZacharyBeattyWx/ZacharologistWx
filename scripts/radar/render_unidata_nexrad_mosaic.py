#!/usr/bin/env python3
"""Render Unidata's national NEXRAD composite with the Zacharologist reflectivity palette.

This is an experimental College-of-DuPage-style national mosaic path. It intentionally
stays separate from the production MRMS loop while we compare the two products.

Source priority:
  1. N0B 1-km base reflectivity national composite
  2. DHR 1-km digital hybrid reflectivity national composite
  3. legacy N0R 1-km base reflectivity national composite

Unidata publishes these as PNG-compressed GINI images. A lightweight local decoder
reads only the GINI navigation and embedded raster fields needed here; this script
converts the image calibration back to dBZ, reprojects the Lambert/GINI grid onto the
same regular lon/lat texture geometry used by our MRMS map, and then calls the
existing Zacharologist reflectivity colorizer.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import re
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
import requests

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

import render_mrms_mosaic as palette_renderer  # noqa: E402
from unidata_gini_lite import GiniFileLite, decode_gini  # noqa: E402

DEFAULT_OUTPUT = REPO_ROOT / "unidata-nexrad-mosaic-output"
DEFAULT_BOUNDS = (-130.0, 20.0, -60.0, 55.0)  # west, south, east, north
DEFAULT_MAX_WIDTH = 4096
CATALOG_HOSTS = (
    "https://tds.scigw.unidata.ucar.edu",
    "https://thredds.ucar.edu",
)
PRODUCTS = ("n0b", "dhr", "n0r")
NODATA = np.float32(-9999.0)
STAMP_RE = re.compile(r"(?P<date>\d{8})[_-](?P<time>\d{4,6})")


def catalog_candidates(product: str, day: datetime):
    stamp = day.strftime("%Y%m%d")
    for host in CATALOG_HOSTS:
        yield host, f"{host}/thredds/catalog/nexrad/composite/gini/{product}/1km/{stamp}/catalog.xml"
        yield host, f"{host}/thredds/catalog/nexrad/composite/gini/{product}/{stamp}/catalog.xml"


def dataset_timestamp(name: str) -> datetime:
    match = STAMP_RE.search(name)
    if not match:
        return datetime.min.replace(tzinfo=timezone.utc)
    raw_time = match.group("time")
    if len(raw_time) == 4:
        raw_time += "00"
    try:
        return datetime.strptime(match.group("date") + raw_time, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def discover_latest_gini(session: requests.Session, requested_product: str = "auto"):
    now = datetime.now(timezone.utc)
    products = PRODUCTS if requested_product == "auto" else (requested_product.lower(),)
    errors: list[str] = []

    for product in products:
        for day_offset in range(0, 3):
            day = now - timedelta(days=day_offset)
            for host, catalog_url in catalog_candidates(product, day):
                try:
                    response = session.get(catalog_url, timeout=20)
                    if response.status_code != 200:
                        errors.append(f"{response.status_code} {catalog_url}")
                        continue
                    root = ET.fromstring(response.content)
                except Exception as exc:
                    errors.append(f"{catalog_url}: {exc}")
                    continue

                datasets = []
                for elem in root.iter():
                    if not elem.tag.endswith("dataset"):
                        continue
                    name = elem.attrib.get("name", "")
                    url_path = elem.attrib.get("urlPath", "")
                    if not url_path or ".gini" not in (name + url_path).lower():
                        continue
                    datasets.append((dataset_timestamp(name or url_path), name, url_path))

                if not datasets:
                    errors.append(f"No GINI datasets in {catalog_url}")
                    continue

                datasets.sort(key=lambda item: item[0], reverse=True)
                timestamp, name, url_path = datasets[0]
                file_url = f"{host}/thredds/fileServer/{url_path.lstrip('/')}"
                return {
                    "product": product.upper(),
                    "catalog_url": catalog_url,
                    "file_url": file_url,
                    "dataset_name": name,
                    "timestamp": timestamp,
                }

    detail = "\n  ".join(errors[-12:])
    raise RuntimeError(f"Could not discover a current Unidata national NEXRAD GINI composite.\n  {detail}")


def calibrate_to_dbz(raw: np.ndarray, product: str) -> np.ndarray:
    """Convert Unidata NEX2GINI image bytes back to physical reflectivity."""
    values = raw.astype(np.float32, copy=False)
    out = np.full(values.shape, NODATA, dtype=np.float32)
    product = product.upper()

    if product == "N0B":
        out[:] = -32.0 + values * (127.0 / 255.0)
    elif product == "DHR":
        valid = values >= 2
        out[valid] = -32.0 + (values[valid] - 2.0) * 0.5
    elif product == "N0R":
        valid = values <= 105
        out[valid] = values[valid] - 30.0
    else:
        raise ValueError(f"Unsupported reflectivity product: {product}")

    return out


def reproject_gini_to_lonlat(gini: GiniFileLite, product: str, bounds, max_width: int) -> np.ndarray:
    west, south, east, north = map(float, bounds)
    width = max(512, int(max_width))
    height = max(256, int(round(width * (north - south) / (east - west))))

    raw = np.asarray(gini.data)
    ny, nx = raw.shape
    proj, dx_km, dy_km = gini._get_proj_and_res()

    x0, y0 = proj(gini.prod_desc.lo1, gini.prod_desc.la1)
    dx_m = float(dx_km) * 1000.0
    dy_m = float(dy_km) * 1000.0
    top_y = y0 + (ny - 1) * dy_m

    lon_axis = np.linspace(west, east, width, dtype=np.float64)
    lat_axis = np.linspace(north, south, height, dtype=np.float64)
    output = np.full((height, width), NODATA, dtype=np.float32)

    chunk_rows = 96
    for row0 in range(0, height, chunk_rows):
        row1 = min(height, row0 + chunk_rows)
        lats = lat_axis[row0:row1]
        lon_grid, lat_grid = np.meshgrid(lon_axis, lats)
        x_grid, y_grid = proj(lon_grid, lat_grid)

        col_index = np.rint((x_grid - x0) / dx_m).astype(np.int64)
        row_index = np.rint((top_y - y_grid) / dy_m).astype(np.int64)
        valid = (
            np.isfinite(x_grid)
            & np.isfinite(y_grid)
            & (col_index >= 0)
            & (col_index < nx)
            & (row_index >= 0)
            & (row_index < ny)
        )
        if not np.any(valid):
            continue

        raw_chunk = np.zeros((row1 - row0, width), dtype=np.uint8)
        raw_chunk[valid] = raw[row_index[valid], col_index[valid]]
        dbz_chunk = calibrate_to_dbz(raw_chunk, product)
        dbz_chunk[~valid] = NODATA
        output[row0:row1] = dbz_chunk

    return output


def render(args) -> Path:
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers.update({"User-Agent": "ZacharologistWx/Unidata-NEXRAD-mosaic-test"})

    print("Discovering latest Unidata national NEXRAD composite...")
    source = discover_latest_gini(session, args.product)
    print(f"Using {source['product']}: {source['dataset_name']}")
    print(f"Download {source['file_url']}")
    response = session.get(source["file_url"], timeout=60)
    response.raise_for_status()
    print(f"Downloaded {len(response.content) / 1024:.1f} KiB")

    gini = decode_gini(response.content)
    print(gini)
    print(f"Raw raster: {gini.data.shape[1]}x{gini.data.shape[0]} values={int(np.min(gini.data))}..{int(np.max(gini.data))}")

    bounds = tuple(args.bounds)
    dbz = reproject_gini_to_lonlat(gini, source["product"], bounds, args.max_width)
    valid = dbz > -9000
    if not np.any(valid):
        raise RuntimeError("Reprojection produced no valid pixels.")

    print(
        f"Reprojected: {dbz.shape[1]}x{dbz.shape[0]} "
        f"dBZ={float(np.min(dbz[valid])):.1f}..{float(np.max(dbz[valid])):.1f}"
    )

    rgba = palette_renderer.colorize_dbz_grid_for_tiles(dbz)
    image_path = output_dir / "desktop.webp"
    Image.fromarray(rgba, mode="RGBA").save(image_path, "WEBP", lossless=True, method=4)

    valid_time = source["timestamp"]
    if valid_time.year <= 1900:
        valid_time = gini.prod_desc.datetime.replace(tzinfo=timezone.utc)

    revision = int(datetime.now(timezone.utc).timestamp())
    manifest = {
        "revision": revision,
        "source": "NSF Unidata national NEXRAD composite",
        "product": source["product"],
        "dataset": source["dataset_name"],
        "catalogUrl": source["catalog_url"],
        "sourceUrl": source["file_url"],
        "valid_time": valid_time.isoformat(),
        "image": "desktop.webp",
        "imageWidth": int(dbz.shape[1]),
        "imageHeight": int(dbz.shape[0]),
        "bounds": list(map(float, bounds)),
        "sourceGridWidth": int(gini.data.shape[1]),
        "sourceGridHeight": int(gini.data.shape[0]),
        "projection": gini.prod_desc.projection.name,
        "colorOwner": "Zacharologist reflectivity palette renderer",
        "calibration": {
            "N0B": "raw 0..255 -> -32..95 dBZ",
            "DHR": "raw 0/1 missing/bad; 2..255 -> -32..94.5 dBZ",
            "N0R": "raw 0..105 -> -30..75 dBZ",
        }.get(source["product"]),
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Wrote {image_path}")
    print(f"Wrote {output_dir / 'manifest.json'}")
    return image_path


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", choices=("auto", "n0b", "dhr", "n0r"), default="auto")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--max-width", type=int, default=DEFAULT_MAX_WIDTH)
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
