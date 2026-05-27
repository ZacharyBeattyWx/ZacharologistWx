#!/usr/bin/env python3
"""Experimental projected Level II reflectivity (dBZ) GeoTIFF renderer for KFCX."""

from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from metpy.io import Level2File

try:
    import rasterio
    from rasterio.transform import from_bounds
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "rasterio is required for GeoTIFF output. Install with: pip install rasterio"
    ) from exc

try:
    from pyproj import CRS, Transformer
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "pyproj is required for projected sampling. Install with: pip install pyproj"
    ) from exc

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
LEVEL2_ROOT = REPO_ROOT / "radar" / "source" / "level2" / "KFCX"
OUTPUT_ROOT = REPO_ROOT / "radar" / "tilesets" / "test" / "KFCX" / "LEVEL2" / "REF0"
FRAMES_JSON = REPO_ROOT / "radar" / "frames.json"
NODATA = -9999.0
OUTPUT_SIZE = 4096
KEY_RE = re.compile(r"(?P<site>K[A-Z0-9]{3})(?P<ts>\d{8}_\d{6})")


@dataclass
class SweepData:
    reflectivity: np.ndarray
    azimuth_deg: np.ndarray
    first_gate_km: float
    gate_width_km: float
    elevation_deg: float
    site_lat: float
    site_lon: float


def infer_valid_time_from_name(path: Path) -> str | None:
    match = KEY_RE.search(path.name)
    if not match:
        return None
    try:
        dt = datetime.strptime(match.group("ts"), "%Y%m%d_%H%M%S").replace(tzinfo=UTC)
        return dt.isoformat()
    except ValueError:
        return None


def latest_level2_file(input_root: Path) -> Path:
    if not input_root.exists():
        raise FileNotFoundError(f"Level II input directory missing: {input_root}")
    files = sorted(p for p in input_root.iterdir() if p.is_file())
    if not files:
        raise FileNotFoundError(f"No Level II files in: {input_root}")
    return files[-1]


def load_bounds_from_frames_json() -> tuple[float, float, float, float]:
    fallback = (-86.6, 32.2, -73.4, 42.2)  # west, south, east, north
    if not FRAMES_JSON.exists():
        return fallback

    data = json.loads(FRAMES_JSON.read_text(encoding="utf-8"))
    frames = data.get("frames", {}).get("KFCX", {}).get("N0B", [])
    if not isinstance(frames, list) or not frames:
        return fallback

    bounds = frames[0].get("bounds")
    if (
        isinstance(bounds, list)
        and len(bounds) == 2
        and isinstance(bounds[0], list)
        and isinstance(bounds[1], list)
        and len(bounds[0]) == 2
        and len(bounds[1]) == 2
    ):
        south, west = float(bounds[0][0]), float(bounds[0][1])
        north, east = float(bounds[1][0]), float(bounds[1][1])
        return west, south, east, north

    return fallback


def extract_lowest_reflectivity_sweep(level2: Level2File) -> SweepData:
    best: SweepData | None = None

    for sweep in level2.sweeps:
        if not sweep:
            continue

        rays_with_ref = [ray for ray in sweep if isinstance(ray, tuple) and len(ray) >= 5 and b"REF" in ray[4]]
        if not rays_with_ref:
            continue

        first_ray = rays_with_ref[0]
        ref_hdr = first_ray[4][b"REF"][0]
        num_gates = int(ref_hdr.num_gates)
        ref_rows = []
        azimuths = []

        for ray in rays_with_ref:
            azimuths.append(float(ray[0].az_angle))
            row = np.asarray(ray[4][b"REF"][1], dtype=np.float32)
            if row.shape[0] < num_gates:
                padded = np.full((num_gates,), np.nan, dtype=np.float32)
                padded[: row.shape[0]] = row
                row = padded
            elif row.shape[0] > num_gates:
                row = row[:num_gates]
            ref_rows.append(row)

        ref = np.stack(ref_rows, axis=0)
        az = np.asarray(azimuths, dtype=np.float32)
        elevation = float(first_ray[0].el_angle)
        site_lat = float(first_ray[1].lat)
        site_lon = float(first_ray[1].lon)

        current = SweepData(
            reflectivity=ref,
            azimuth_deg=az,
            first_gate_km=float(ref_hdr.first_gate),
            gate_width_km=float(ref_hdr.gate_width),
            elevation_deg=elevation,
            site_lat=site_lat,
            site_lon=site_lon,
        )

        if best is None or current.elevation_deg < best.elevation_deg:
            best = current

    if best is None:
        raise RuntimeError("No reflectivity moments (REF) found in Level II file")

    return best


def circular_nearest_indices(angles_deg: np.ndarray, targets_deg: np.ndarray) -> np.ndarray:
    order = np.argsort(angles_deg)
    sorted_angles = angles_deg[order]
    pos = np.searchsorted(sorted_angles, targets_deg, side="left")

    left_pos = (pos - 1) % sorted_angles.size
    right_pos = pos % sorted_angles.size

    left_angles = sorted_angles[left_pos]
    right_angles = sorted_angles[right_pos]

    left_dist = np.abs(((targets_deg - left_angles + 180.0) % 360.0) - 180.0)
    right_dist = np.abs(((targets_deg - right_angles + 180.0) % 360.0) - 180.0)

    choose_right = right_dist < left_dist
    chosen_pos = np.where(choose_right, right_pos, left_pos)
    return order[chosen_pos]


def build_projected_dbz_grid(
    sweep: SweepData,
    bounds: tuple[float, float, float, float],
    output_size: int,
    nodata: float,
    row_chunk: int = 128,
) -> np.ndarray:
    west, south, east, north = bounds
    out = np.full((output_size, output_size), nodata, dtype=np.float32)

    lon_step = (east - west) / output_size
    lat_step = (north - south) / output_size

    lons = west + (np.arange(output_size, dtype=np.float64) + 0.5) * lon_step

    aeqd = CRS.from_proj4(
        f"+proj=aeqd +lat_0={sweep.site_lat} +lon_0={sweep.site_lon} +datum=WGS84 +units=m +no_defs"
    )
    tx = Transformer.from_crs("EPSG:4326", aeqd, always_xy=True)

    num_gates = sweep.reflectivity.shape[1]
    max_range_km = sweep.first_gate_km + sweep.gate_width_km * (num_gates - 1)

    for y0 in range(0, output_size, row_chunk):
        y1 = min(output_size, y0 + row_chunk)
        lat_rows = north - (np.arange(y0, y1, dtype=np.float64) + 0.5) * lat_step

        lon_grid, lat_grid = np.meshgrid(lons, lat_rows)
        flat_lon = lon_grid.ravel()
        flat_lat = lat_grid.ravel()

        x_m, y_m = tx.transform(flat_lon, flat_lat)
        x_m = np.asarray(x_m, dtype=np.float64)
        y_m = np.asarray(y_m, dtype=np.float64)

        range_km = np.hypot(x_m, y_m) / 1000.0
        azimuth = (np.degrees(np.arctan2(x_m, y_m)) + 360.0) % 360.0

        gate_idx = np.rint((range_km - sweep.first_gate_km) / sweep.gate_width_km).astype(np.int32)
        in_range = (gate_idx >= 0) & (gate_idx < num_gates) & (range_km <= max_range_km)

        chunk_vals = np.full(flat_lon.shape[0], nodata, dtype=np.float32)
        if np.any(in_range):
            az_idx = circular_nearest_indices(sweep.azimuth_deg, azimuth[in_range])
            sample = sweep.reflectivity[az_idx, gate_idx[in_range]]
            sample = np.asarray(sample, dtype=np.float32)
            valid = np.isfinite(sample)

            idx_in = np.flatnonzero(in_range)
            valid_positions = idx_in[valid]
            chunk_vals[valid_positions] = sample[valid]

        out[y0:y1, :] = chunk_vals.reshape(y1 - y0, output_size)

    return out


def write_geotiff(
    path: Path,
    grid: np.ndarray,
    bounds: tuple[float, float, float, float],
    nodata: float,
) -> None:
    west, south, east, north = bounds
    path.parent.mkdir(parents=True, exist_ok=True)
    transform = from_bounds(west, south, east, north, grid.shape[1], grid.shape[0])

    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=grid.shape[1],
        height=grid.shape[0],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
        nodata=nodata,
        compress="deflate",
    ) as dst:
        dst.write(grid, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render experimental Level II projected dBZ GeoTIFF.")
    parser.add_argument("--site", default="KFCX")
    parser.add_argument("--input", type=Path, default=None, help="Optional explicit Level II input file")
    parser.add_argument("--output-size", type=int, default=OUTPUT_SIZE)
    parser.add_argument("--nodata", type=float, default=NODATA)
    args = parser.parse_args()

    site = args.site.strip().upper()
    if site != "KFCX":
        raise SystemExit("This experimental renderer currently supports KFCX only.")

    source_path = args.input if args.input else latest_level2_file(LEVEL2_ROOT)
    with source_path.open("rb") as handle:
        level2 = Level2File(handle)

    sweep = extract_lowest_reflectivity_sweep(level2)
    valid_time = level2.dt.isoformat() if getattr(level2, "dt", None) else infer_valid_time_from_name(source_path)
    valid_time = valid_time or "unknown"

    bounds = load_bounds_from_frames_json()
    grid = build_projected_dbz_grid(
        sweep=sweep,
        bounds=bounds,
        output_size=args.output_size,
        nodata=args.nodata,
    )

    if grid.shape != (args.output_size, args.output_size):
        raise RuntimeError(f"Projected grid shape mismatch: {grid.shape}")

    slug_base = source_path.name
    match = KEY_RE.search(source_path.name)
    if match:
        slug_base = f"{match.group('site')}_{match.group('ts')}"

    output_path = OUTPUT_ROOT / f"{slug_base}_projected_dbz.tif"
    write_geotiff(path=output_path, grid=grid, bounds=bounds, nodata=args.nodata)

    valid_mask = np.isfinite(grid) & (grid != args.nodata)
    valid_count = int(valid_mask.sum())
    nodata_count = int(grid.size - valid_count)
    finite_vals = grid[valid_mask]
    min_dbz = float(np.min(finite_vals)) if valid_count else math.nan
    max_dbz = float(np.max(finite_vals)) if valid_count else math.nan

    latest_json = OUTPUT_ROOT / "latest.json"
    latest_json.write_text(
        json.dumps(
            {
                "site": site,
                "product": "LEVEL2_REF0",
                "sourceFile": str(source_path.name),
                "validTime": valid_time,
                "bounds": {
                    "west": bounds[0],
                    "south": bounds[1],
                    "east": bounds[2],
                    "north": bounds[3],
                },
                "path": f"/radar/tilesets/test/KFCX/LEVEL2/REF0/{output_path.name}",
                "width": int(grid.shape[1]),
                "height": int(grid.shape[0]),
                "nodata": args.nodata,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"radarSite={site}")
    print(f"validTime={valid_time}")
    print(f"sweepElevationDeg={sweep.elevation_deg:.3f}")
    print(f"sourceShape={sweep.reflectivity.shape[0]}x{sweep.reflectivity.shape[1]}")
    print(f"outputShape={grid.shape[0]}x{grid.shape[1]}")
    print(f"finiteMinDbz={min_dbz if np.isfinite(min_dbz) else 'nan'}")
    print(f"finiteMaxDbz={max_dbz if np.isfinite(max_dbz) else 'nan'}")
    print(f"validPixels={valid_count}")
    print(f"nodataPixels={nodata_count}")
    print(f"outputPath={output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
