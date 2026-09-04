#!/usr/bin/env python3
"""Render a seamless ~250 m regional NEXRAD N0B mosaic in Web Mercator geometry.

This is the high-quality experimental tier for ZacharologistWx. It reuses the
existing individual-site Level III N0B decoder/compositor, but samples the
finished site mosaic on the same Web Mercator pixel geometry used by Mapbox.
Negative-dBZ returns are preserved and the national N0B composite fills gaps.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

import render_unidata_nexrad_mosaic as national
import render_unidata_nexrad_site_mosaic as base

TARGET_GROUND_METERS = 250.0
MAX_WIDTH = 8192
MIN_WIDTH = 1024


def target_width(bounds, meters_per_pixel: float) -> int:
    west, south, east, north = map(float, bounds)
    center_lat = (south + north) * 0.5
    ground_m_per_degree_lon = 111_319.49079327358 * max(
        0.15,
        math.cos(math.radians(center_lat)),
    )
    width = int(round((east - west) * ground_m_per_degree_lon / meters_per_pixel))
    return max(MIN_WIDTH, min(MAX_WIDTH, width))


def sample_mosaic_mercator(sweeps, bounds, width: int) -> np.ndarray:
    west, south, east, north = map(float, bounds)
    width = max(512, int(width))

    north_y = float(national._web_mercator_y(north))
    south_y = float(national._web_mercator_y(south))
    x_span = (east - west) / 360.0
    y_span = south_y - north_y
    if x_span <= 0 or y_span <= 0:
        raise ValueError(f"Invalid mosaic bounds: {bounds!r}")

    height = max(256, int(round(width * y_span / x_span)))
    lon_axis = np.linspace(west, east, width, dtype=np.float64)
    mercator_y_axis = np.linspace(north_y, south_y, height, dtype=np.float64)
    lat_axis = national._latitude_from_web_mercator_y(mercator_y_axis)
    output = np.full((height, width), base.NODATA, dtype=np.float32)

    chunk_rows = 72
    for row0 in range(0, height, chunk_rows):
        row1 = min(height, row0 + chunk_rows)
        lats = lat_axis[row0:row1]
        chunk_south = float(np.min(lats))
        chunk_north = float(np.max(lats))
        lon_grid, lat_grid = np.meshgrid(lon_axis, lats)
        chunk_dbz = np.full(lon_grid.shape, base.NODATA, dtype=np.float32)

        for sweep in sweeps:
            lat_margin = sweep.max_range_km / 111.0
            lon_scale = max(0.2, math.cos(math.radians(sweep.lat)))
            lon_margin = sweep.max_range_km / (111.0 * lon_scale)
            if sweep.lat < chunk_south - lat_margin or sweep.lat > chunk_north + lat_margin:
                continue
            if sweep.lon < west - lon_margin or sweep.lon > east + lon_margin:
                continue

            radar_lon = np.full(lon_grid.shape, sweep.lon, dtype=np.float64)
            radar_lat = np.full(lat_grid.shape, sweep.lat, dtype=np.float64)
            forward_az, _, distance_m = base.GEOD.inv(
                radar_lon,
                radar_lat,
                lon_grid,
                lat_grid,
            )
            distance_km = distance_m / 1000.0
            in_range = (
                np.isfinite(distance_km)
                & (distance_km >= 0.0)
                & (distance_km <= sweep.max_range_km)
            )
            if not np.any(in_range):
                continue

            bearing = np.mod(forward_az, 360.0)
            az_bin = np.mod(
                np.rint(bearing * (len(sweep.ray_lookup) / 360.0)).astype(np.int32),
                len(sweep.ray_lookup),
            )
            ray_index = sweep.ray_lookup[az_bin]
            gate_count = sweep.data.shape[1]
            gate_index = np.floor(
                distance_km / sweep.max_range_km * gate_count
            ).astype(np.int32)
            gate_index = np.clip(gate_index, 0, gate_count - 1)
            sampled = sweep.data[ray_index, gate_index]
            valid = in_range & np.isfinite(sampled)

            empty = chunk_dbz <= -9000
            use = valid & (empty | (sampled > chunk_dbz))
            chunk_dbz[use] = sampled[use]

        output[row0:row1] = chunk_dbz
        print(f"250 m site mosaic rows {row1}/{height}", end="\r", flush=True)

    print()
    return output


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(base.DEFAULT_OUTPUT) + "-250m")
    parser.add_argument("--sites", default="auto")
    parser.add_argument("--meters-per-pixel", type=float, default=TARGET_GROUND_METERS)
    parser.add_argument("--width", type=int, default=0, help="Override automatic target width")
    parser.add_argument(
        "--bounds",
        type=float,
        nargs=4,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        default=base.DEFAULT_BOUNDS,
    )
    return parser.parse_args()


def main():
    args = parse_args()
    if args.meters_per_pixel <= 0:
        raise SystemExit("--meters-per-pixel must be positive")

    width = int(args.width) if int(args.width) > 0 else target_width(
        args.bounds,
        args.meters_per_pixel,
    )
    print(
        f"Target detail grid: ~{args.meters_per_pixel:.0f} m ground sampling "
        f"at region center -> width {width}px"
    )

    # The base renderer handles station discovery, N0B decoding, numeric merge,
    # palette ownership and manifest writing. Replace only its grid sampler.
    base.sample_mosaic = sample_mosaic_mercator
    args.width = width
    base.render(args)

    manifest_path = Path(args.output).resolve() / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["targetGroundResolutionMeters"] = float(args.meters_per_pixel)
    manifest["gridGeometry"] = "Web Mercator aligned; individual N0B + national N0B fallback"
    manifest["qualityTier"] = "regional-250m-experimental"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Updated {manifest_path} with 250 m quality metadata")


if __name__ == "__main__":
    main()
