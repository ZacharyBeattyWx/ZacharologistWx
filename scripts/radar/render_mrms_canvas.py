#!/usr/bin/env python3
"""Render NOAA MRMS ReflectivityAtLowestAltitude for the Site Radar canvas path.

This proof-of-concept intentionally mirrors the Site Radar display architecture:
1. download/decode numeric MRMS dBZ,
2. colorize with the existing Level II tile colorizer,
3. write one pre-colored transparent WebP image,
4. let the browser draw that image on an HTML canvas overlay.

The goal is to remove Mapbox raster compositing from the comparison entirely.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from PIL import Image

import render_mrms_mosaic as mrms

REPO_ROOT = mrms.REPO_ROOT
DEFAULT_OUTPUT = REPO_ROOT / "mrms-mosaic-canvas-output"
DEFAULT_MAX_WIDTH = 5120


def downsample_nearest(grid: np.ndarray, max_width: int) -> np.ndarray:
    """Preserve native dBZ bins while limiting browser texture memory."""
    height, width = grid.shape
    if width <= max_width:
        return grid

    scale = max_width / float(width)
    out_width = max(1, int(round(width * scale)))
    out_height = max(1, int(round(height * scale)))

    x_idx = np.linspace(0, width - 1, out_width).round().astype(np.int32)
    y_idx = np.linspace(0, height - 1, out_height).round().astype(np.int32)
    return grid[np.ix_(y_idx, x_idx)]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--source-url", default=mrms.MRMS_LATEST_URL)
    parser.add_argument("--source-gz", default=None)
    parser.add_argument("--max-width", type=int, default=DEFAULT_MAX_WIDTH)
    return parser.parse_args()


def main():
    args = parse_args()
    output_root = Path(args.output).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="mrms-canvas-") as temp_name:
        temp_root = Path(temp_name)
        gz_path = temp_root / "latest.grib2.gz"
        grib_path = temp_root / "latest.grib2"

        if args.source_gz:
            source_path = Path(args.source_gz).resolve()
            if not source_path.exists():
                raise SystemExit(f"Source file not found: {source_path}")
            shutil.copy2(source_path, gz_path)
        else:
            mrms.download_latest(args.source_url, gz_path)

        with gzip.open(gz_path, "rb") as source, grib_path.open("wb") as target:
            shutil.copyfileobj(source, target)

        decoded = mrms.decode_mrms_grib2(grib_path)

    grid = decoded["grid"]
    bounds = decoded["bounds"]
    finite = grid[grid != mrms.NODATA]
    if not finite.size:
        raise RuntimeError("Decoded MRMS grid contains no valid reflectivity values")

    print(
        f"Decoded MRMS {decoded['nx']}x{decoded['ny']} bounds={bounds} "
        f"dBZ={float(finite.min()):.1f}..{float(finite.max()):.1f}",
        flush=True,
    )

    sampled = downsample_nearest(grid, max(256, int(args.max_width)))
    rgba = mrms.colorize_dbz_grid_for_tiles(sampled, mrms.NODATA)

    image_path = output_root / "desktop.webp"
    Image.fromarray(rgba, mode="RGBA").save(
        image_path,
        format="WEBP",
        lossless=True,
        method=4,
    )

    now = datetime.now(UTC)
    valid_time = decoded["valid_time"] or now
    revision = int(time.time())
    manifest = {
        "generated_at": now.isoformat(),
        "valid_time": valid_time.isoformat(),
        "revision": revision,
        "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
        "units": "dBZ",
        "bounds": list(bounds),
        "image": "desktop.webp",
        "imageWidth": int(sampled.shape[1]),
        "imageHeight": int(sampled.shape[0]),
        "palette": str(mrms.PALETTE_FILE.relative_to(REPO_ROOT)).replace("\\", "/"),
        "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
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

    visible = int(np.count_nonzero(rgba[..., 3]))
    print(
        f"Wrote {sampled.shape[1]}x{sampled.shape[0]} lossless WebP "
        f"({visible:,} visible pixels) -> {image_path}",
        flush=True,
    )
    print(f"Valid time: {valid_time.isoformat()}", flush=True)
    print(f"Revision: {revision}", flush=True)


if __name__ == "__main__":
    main()
