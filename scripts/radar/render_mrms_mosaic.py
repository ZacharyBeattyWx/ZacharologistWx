#!/usr/bin/env python3
"""Render NOAA MRMS ReflectivityAtLowestAltitude into Level-II-colored XYZ tiles.

This is intentionally a local/proof-of-concept renderer first. It downloads the
latest numeric MRMS GRIB2 field, decodes it with ecCodes, applies the same
ZacharologistWx reflectivity palette and low-dBZ cleanup used by the Level II
tile renderer, and writes a small Web-Mercator XYZ tile pyramid plus manifest.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import shutil
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import requests
from eccodes import (
    codes_get,
    codes_get_array,
    codes_get_long,
    codes_grib_new_from_file,
    codes_release,
)
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
PALETTE_FILE = SCRIPT_DIR / "palettes" / "zacharologist-reflectivity.pal"

MRMS_LATEST_URL = (
    "https://mrms.ncep.noaa.gov/2D/ReflectivityAtLowestAltitude/"
    "MRMS_ReflectivityAtLowestAltitude.latest.grib2.gz"
)
USER_AGENT = "ZacharologistWx/1.0 MRMS mosaic renderer (zacharologistwx.com)"

NODATA = -9999.0
DISPLAY_MIN_DBZ = -32.0
TILE_DISPLAY_MIN_DBZ = -5.0
TILE_SIZE = 256
DEFAULT_MIN_ZOOM = 2
DEFAULT_MAX_ZOOM = 7

RADAR_DBZ_PALETTE_FALLBACK = [
    (-32, 88, 54, 128, 8),
    (-30, 96, 62, 138, 10),
    (-28, 105, 72, 145, 12),
    (-26, 116, 85, 150, 15),
    (-24, 128, 99, 153, 18),
    (-22, 139, 113, 153, 22),
    (-20, 148, 128, 150, 28),
    (-18, 155, 140, 145, 34),
    (-16, 160, 150, 138, 42),
    (-14, 163, 157, 130, 52),
    (-12, 160, 158, 123, 62),
    (-10, 156, 155, 119, 72),
    (-8, 167, 167, 136, 80),
    (-6, 175, 176, 150, 88),
    (-4, 158, 163, 150, 98),
    (-2, 135, 144, 145, 108),
    (0, 115, 128, 142, 120),
    (2, 92, 109, 137, 132),
    (4, 73, 93, 133, 144),
    (6, 55, 81, 132, 156),
    (8, 63, 97, 141, 168),
    (10, 73, 117, 152, 180),
    (15, 76, 165, 142, 205),
    (20, 18, 118, 24, 230),
    (25, 203, 222, 1, 245),
    (30, 215, 203, 0, 255),
    (35, 227, 129, 3, 255),
    (40, 185, 95, 10, 255),
    (45, 192, 37, 20, 255),
    (50, 202, 153, 180, 255),
    (55, 196, 74, 138, 255),
    (60, 139, 32, 210, 255),
    (65, 86, 20, 162, 255),
    (70, 111, 210, 219, 255),
    (75, 74, 132, 154, 255),
    (80, 115, 10, 1, 255),
    (85, 235, 190, 255, 255),
    (90, 255, 230, 245, 255),
    (95, 255, 255, 255, 255),
]

LOW_DBZ_OPACITY_TAPER = [
    (-32, 0.0),
    (-20, 0.01),
    (-10, 0.04),
    (0, 0.12),
    (5, 0.32),
    (10, 0.7),
    (15, 1.0),
]


def load_radar_palette(path: Path = PALETTE_FILE):
    if not path.exists():
        return RADAR_DBZ_PALETTE_FALLBACK

    stops = []
    numeric_re = re.compile(r"[-+]?\d+(?:\.\d+)?")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", ";", "//")):
            continue
        values = numeric_re.findall(line)
        if len(values) < 4:
            continue
        dbz = float(values[0])
        red = int(round(float(values[1])))
        green = int(round(float(values[2])))
        blue = int(round(float(values[3])))
        alpha = int(round(float(values[4]))) if len(values) >= 5 else 255
        stops.append((
            dbz,
            max(0, min(255, red)),
            max(0, min(255, green)),
            max(0, min(255, blue)),
            max(0, min(255, alpha)),
        ))

    if not stops:
        raise RuntimeError(f"No valid palette stops found in {path}")
    stops.sort(key=lambda stop: stop[0])
    return stops


RADAR_DBZ_PALETTE = load_radar_palette()


def colorize_dbz_grid(grid: np.ndarray, nodata: float = NODATA) -> np.ndarray:
    sampled = np.asarray(grid, dtype=np.float32)
    rgba = np.zeros((sampled.shape[0], sampled.shape[1], 4), dtype=np.uint8)

    valid = np.isfinite(sampled) & (sampled != nodata) & (sampled >= DISPLAY_MIN_DBZ)
    if not np.any(valid):
        return rgba

    values = sampled[valid]
    stops = np.asarray([stop[0] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    red = np.asarray([stop[1] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    green = np.asarray([stop[2] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    blue = np.asarray([stop[3] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    alpha = np.asarray([stop[4] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)

    taper_stops = np.asarray([stop[0] for stop in LOW_DBZ_OPACITY_TAPER], dtype=np.float32)
    taper_values = np.asarray([stop[1] for stop in LOW_DBZ_OPACITY_TAPER], dtype=np.float32)

    rgba[..., 0][valid] = np.clip(np.interp(values, stops, red), 0, 255).astype(np.uint8)
    rgba[..., 1][valid] = np.clip(np.interp(values, stops, green), 0, 255).astype(np.uint8)
    rgba[..., 2][valid] = np.clip(np.interp(values, stops, blue), 0, 255).astype(np.uint8)

    base_alpha = np.interp(values, stops, alpha)
    taper_alpha = np.interp(values, taper_stops, taper_values)
    rgba[..., 3][valid] = np.clip(base_alpha * taper_alpha, 0, 255).astype(np.uint8)

    black_with_alpha = (
        (rgba[..., 0] == 0)
        & (rgba[..., 1] == 0)
        & (rgba[..., 2] == 0)
        & (rgba[..., 3] > 0)
    )
    rgba[..., 3][black_with_alpha] = 0
    return rgba


def colorize_dbz_grid_for_tiles(grid: np.ndarray, nodata: float = NODATA) -> np.ndarray:
    sampled = np.asarray(grid, dtype=np.float32)
    rgba = colorize_dbz_grid(sampled, nodata)
    valid = np.isfinite(sampled) & (sampled != nodata)

    weak = valid & (sampled < TILE_DISPLAY_MIN_DBZ)
    rgba[..., 3][weak] = 0

    low = valid & (sampled >= TILE_DISPLAY_MIN_DBZ) & (sampled < 10.0)
    if np.any(low):
        values = sampled[low]
        ramp_dbz = [TILE_DISPLAY_MIN_DBZ, 0.0, 10.0]
        rgba[..., 0][low] = np.clip(
            np.interp(values, ramp_dbz, [28, 40, 70]), 0, 255
        ).astype(np.uint8)
        rgba[..., 1][low] = np.clip(
            np.interp(values, ramp_dbz, [95, 115, 210]), 0, 255
        ).astype(np.uint8)
        rgba[..., 2][low] = np.clip(
            np.interp(values, ramp_dbz, [140, 165, 230]), 0, 255
        ).astype(np.uint8)
        rgba[..., 3][low] = np.clip(
            np.interp(values, ramp_dbz, [10, 35, 120]), 0, 255
        ).astype(np.uint8)

    black_with_alpha = (
        (rgba[..., 0] < 8)
        & (rgba[..., 1] < 8)
        & (rgba[..., 2] < 8)
        & (rgba[..., 3] > 0)
    )
    rgba[..., 3][black_with_alpha] = 0
    return rgba


def normalize_lon(value: float) -> float:
    return ((float(value) + 180.0) % 360.0) - 180.0


def get_key(handle, *names, default=None):
    for name in names:
        try:
            return codes_get(handle, name)
        except Exception:
            pass
    if default is not None:
        return default
    raise KeyError(f"None of the GRIB keys are available: {names}")


def get_long_key(handle, *names, default=None):
    for name in names:
        try:
            return int(codes_get_long(handle, name))
        except Exception:
            pass
    if default is not None:
        return int(default)
    raise KeyError(f"None of the GRIB integer keys are available: {names}")


def download_latest(url: str, destination: Path) -> None:
    print(f"Downloading {url}", flush=True)
    response = requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
        timeout=45,
    )
    response.raise_for_status()
    destination.write_bytes(response.content)
    print(f"Downloaded {len(response.content) / 1024:.1f} KiB", flush=True)


def decode_mrms_grib2(grib_path: Path):
    with grib_path.open("rb") as stream:
        handle = codes_grib_new_from_file(stream)
        if handle is None:
            raise RuntimeError("No GRIB2 message found")

        try:
            nx = get_long_key(handle, "Nx", "Ni")
            ny = get_long_key(handle, "Ny", "Nj")
            j_consecutive = bool(get_long_key(handle, "jPointsAreConsecutive", default=0))
            if j_consecutive:
                raise RuntimeError("Unexpected MRMS scanning mode: jPointsAreConsecutive=1")

            values = np.asarray(codes_get_array(handle, "values"), dtype=np.float32)
            if values.size != nx * ny:
                raise RuntimeError(
                    f"GRIB value count {values.size} does not match grid {nx}x{ny}"
                )
            grid = values.reshape(ny, nx)

            lat0 = float(get_key(handle, "latitudeOfFirstGridPointInDegrees"))
            lon0 = normalize_lon(get_key(handle, "longitudeOfFirstGridPointInDegrees"))
            di = abs(float(get_key(handle, "iDirectionIncrementInDegrees")))
            dj = abs(float(get_key(handle, "jDirectionIncrementInDegrees")))
            i_negative = bool(get_long_key(handle, "iScansNegatively", default=0))
            j_positive = bool(get_long_key(handle, "jScansPositively", default=0))

            if i_negative:
                east = lon0
                west = east - di * (nx - 1)
                grid = grid[:, ::-1]
            else:
                west = lon0
                east = west + di * (nx - 1)

            if j_positive:
                south = lat0
                north = south + dj * (ny - 1)
                grid = grid[::-1, :]
            else:
                north = lat0
                south = north - dj * (ny - 1)

            # MRMS table values: -99 = missing, -999 = no coverage. Hide both.
            invalid = (~np.isfinite(grid)) | (grid <= -90.0)
            grid = grid.astype(np.float32, copy=False)
            grid[invalid] = NODATA

            data_date = int(get_key(handle, "dataDate", default=0) or 0)
            data_time = int(get_key(handle, "dataTime", default=0) or 0)
            valid_time = None
            if data_date:
                try:
                    valid_time = datetime.strptime(
                        f"{data_date:08d}{data_time:04d}", "%Y%m%d%H%M"
                    ).replace(tzinfo=UTC)
                except Exception:
                    valid_time = None

            return {
                "grid": grid,
                "bounds": (float(west), float(south), float(east), float(north)),
                "nx": nx,
                "ny": ny,
                "di": di,
                "dj": dj,
                "valid_time": valid_time,
            }
        finally:
            codes_release(handle)


def clamp_mercator_lat(lat: float) -> float:
    return max(-85.05112878, min(85.05112878, float(lat)))


def lon_to_tile_x(lon: float, zoom: int) -> int:
    n = 2 ** zoom
    value = int(math.floor(((float(lon) + 180.0) / 360.0) * n))
    return max(0, min(n - 1, value))


def lat_to_tile_y(lat: float, zoom: int) -> int:
    lat = clamp_mercator_lat(lat)
    n = 2 ** zoom
    lat_rad = math.radians(lat)
    value = int(
        math.floor(
            (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
        )
    )
    return max(0, min(n - 1, value))


def tile_x_to_lon(value, zoom: int):
    return (np.asarray(value) / float(2 ** zoom)) * 360.0 - 180.0


def tile_y_to_lat(value, zoom: int):
    mercator_y = math.pi * (
        1.0 - 2.0 * (np.asarray(value) / float(2 ** zoom))
    )
    return np.degrees(np.arctan(np.sinh(mercator_y)))


def tile_ranges_for_bounds(bounds, zoom: int):
    west, south, east, north = bounds
    x_min = lon_to_tile_x(west, zoom)
    x_max = lon_to_tile_x(east, zoom)
    y_min = lat_to_tile_y(north, zoom)
    y_max = lat_to_tile_y(south, zoom)
    return (
        range(min(x_min, x_max), max(x_min, x_max) + 1),
        range(min(y_min, y_max), max(y_min, y_max) + 1),
    )


def sample_grid_for_tile(grid, bounds, tile_x, tile_y, zoom, tile_size=TILE_SIZE):
    west, south, east, north = bounds
    height, width = grid.shape

    centers = (np.arange(tile_size, dtype=np.float64) + 0.5) / float(tile_size)
    lon_cols = tile_x_to_lon(tile_x + centers, zoom)
    lat_rows = tile_y_to_lat(tile_y + centers, zoom)
    lon_grid, lat_grid = np.meshgrid(lon_cols, lat_rows)

    in_bounds = (
        (lon_grid >= west)
        & (lon_grid <= east)
        & (lat_grid >= south)
        & (lat_grid <= north)
    )

    sampled = np.full((tile_size, tile_size), NODATA, dtype=np.float32)
    if not np.any(in_bounds):
        return sampled

    src_x = ((lon_grid - west) / (east - west)) * width - 0.5
    src_y = ((north - lat_grid) / (north - south)) * height - 0.5
    nearest_x = np.clip(np.rint(src_x), 0, width - 1).astype(np.int32)
    nearest_y = np.clip(np.rint(src_y), 0, height - 1).astype(np.int32)

    nearest_values = grid[nearest_y, nearest_x]
    has_value = in_bounds & np.isfinite(nearest_values) & (nearest_values != NODATA)
    sampled[has_value] = nearest_values[has_value]
    return sampled


def render_tiles(grid, bounds, output_root: Path, min_zoom: int, max_zoom: int):
    tiles_root = output_root / "tiles"
    if tiles_root.exists():
        shutil.rmtree(tiles_root)
    tiles_root.mkdir(parents=True, exist_ok=True)

    tile_count = 0
    echo_tile_count = 0
    for zoom in range(min_zoom, max_zoom + 1):
        x_range, y_range = tile_ranges_for_bounds(bounds, zoom)
        for tile_x in x_range:
            for tile_y in y_range:
                sampled = sample_grid_for_tile(
                    grid,
                    bounds,
                    tile_x,
                    tile_y,
                    zoom,
                )
                rgba = colorize_dbz_grid_for_tiles(sampled, NODATA)
                if int(rgba[..., 3].max()) > 0:
                    echo_tile_count += 1

                tile_path = tiles_root / str(zoom) / str(tile_x) / f"{tile_y}.png"
                tile_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgba, mode="RGBA").save(
                    tile_path,
                    format="PNG",
                    optimize=True,
                )
                tile_count += 1

        print(f"Rendered z{zoom}: {tile_count} cumulative tiles", flush=True)

    return tile_count, echo_tile_count


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        default=str(REPO_ROOT / "mrms-mosaic-output"),
        help="Output directory for manifest.json and tiles/",
    )
    parser.add_argument("--source-url", default=MRMS_LATEST_URL)
    parser.add_argument("--source-gz", default=None, help="Use a local .grib2.gz instead")
    parser.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM)
    parser.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM)
    return parser.parse_args()


def main():
    args = parse_args()
    output_root = Path(args.output).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    if args.max_zoom < args.min_zoom:
        raise SystemExit("--max-zoom must be >= --min-zoom")

    with tempfile.TemporaryDirectory(prefix="mrms-mosaic-") as temp_name:
        temp_root = Path(temp_name)
        gz_path = temp_root / "latest.grib2.gz"
        grib_path = temp_root / "latest.grib2"

        if args.source_gz:
            source_path = Path(args.source_gz).resolve()
            if not source_path.exists():
                raise SystemExit(f"Source file not found: {source_path}")
            shutil.copy2(source_path, gz_path)
        else:
            download_latest(args.source_url, gz_path)

        with gzip.open(gz_path, "rb") as source, grib_path.open("wb") as target:
            shutil.copyfileobj(source, target)

        decoded = decode_mrms_grib2(grib_path)
        grid = decoded["grid"]
        bounds = decoded["bounds"]

        finite = grid[grid != NODATA]
        if finite.size:
            print(
                f"Decoded MRMS {decoded['nx']}x{decoded['ny']} "
                f"bounds={bounds} dBZ={float(finite.min()):.1f}..{float(finite.max()):.1f}",
                flush=True,
            )
        else:
            raise RuntimeError("Decoded MRMS grid contains no valid reflectivity values")

        tile_count, echo_tile_count = render_tiles(
            grid,
            bounds,
            output_root,
            args.min_zoom,
            args.max_zoom,
        )

    now = datetime.now(UTC)
    valid_time = decoded["valid_time"] or now
    manifest = {
        "generated_at": now.isoformat(),
        "valid_time": valid_time.isoformat(),
        "revision": int(time.time()),
        "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
        "source_url": args.source_url,
        "product": "ReflectivityAtLowestAltitude",
        "units": "dBZ",
        "bounds": list(bounds),
        "minzoom": args.min_zoom,
        "maxzoom": args.max_zoom,
        "tileSize": TILE_SIZE,
        "tiles": "tiles/{z}/{x}/{y}.png",
        "tileCount": tile_count,
        "echoTileCount": echo_tile_count,
        "palette": str(PALETTE_FILE.relative_to(REPO_ROOT)).replace("\\", "/"),
        "displayMinDbz": TILE_DISPLAY_MIN_DBZ,
        "grid": {
            "width": decoded["nx"],
            "height": decoded["ny"],
            "lonIncrement": decoded["di"],
            "latIncrement": decoded["dj"],
        },
    }

    (output_root / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )

    print(
        f"Done: {tile_count} tiles ({echo_tile_count} with visible echoes) -> {output_root}",
        flush=True,
    )
    print(f"Valid time: {valid_time.isoformat()}", flush=True)


if __name__ == "__main__":
    main()
