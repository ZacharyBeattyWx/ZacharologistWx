#!/usr/bin/env python3
"""Diagnose raw MRMS reflectivity values and the shared Level II colorizer."""

from __future__ import annotations

import gzip
import shutil
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

import render_mrms_mosaic as mrms


def main() -> int:
    output_root = mrms.REPO_ROOT / "mrms-mosaic-output"
    output_root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="zacharologist-mrms-diagnostic-") as tmp:
        tmp_root = Path(tmp)
        gz_path = tmp_root / "latest.grib2.gz"
        grib_path = tmp_root / "latest.grib2"

        mrms.download_latest(mrms.MRMS_LATEST_URL, gz_path)
        with gzip.open(gz_path, "rb") as source, grib_path.open("wb") as target:
            shutil.copyfileobj(source, target)

        decoded = mrms.decode_mrms_grib2(grib_path)

    grid = np.asarray(decoded["grid"], dtype=np.float32)
    west, south, east, north = decoded["bounds"]
    valid = np.isfinite(grid) & (grid != mrms.NODATA)

    if not np.any(valid):
        raise SystemExit("MRMS grid contains no valid reflectivity values")

    masked = np.where(valid, grid, -np.inf)
    max_flat = int(np.argmax(masked))
    max_y, max_x = np.unravel_index(max_flat, grid.shape)
    max_dbz = float(grid[max_y, max_x])

    lon_step = (east - west) / max(1, grid.shape[1] - 1)
    lat_step = (north - south) / max(1, grid.shape[0] - 1)
    max_lon = west + max_x * lon_step
    max_lat = north - max_y * lat_step

    print("\nMRMS REFLECTIVITY DIAGNOSTIC")
    print(f"Grid: {grid.shape[1]} x {grid.shape[0]}")
    print(f"Bounds: W={west:.3f} S={south:.3f} E={east:.3f} N={north:.3f}")
    print(f"Valid pixels: {int(valid.sum()):,}")
    print(f"Maximum: {max_dbz:.1f} dBZ at approximately {max_lat:.3f}, {max_lon:.3f}")

    for threshold in (-5, 0, 5, 10, 15, 20, 30, 40, 50, 60):
        count = int(np.count_nonzero(valid & (grid >= threshold)))
        print(f">= {threshold:>3} dBZ: {count:,} pixels")

    print("\nRepresentative Level II tile colors:")
    for value in (-5, 0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 65):
        sample = np.array([[float(value)]], dtype=np.float32)
        rgba = mrms.colorize_dbz_grid_for_tiles(sample)[0, 0]
        print(f"{value:>3} dBZ -> RGBA {tuple(int(v) for v in rgba)}")

    # Build a direct whole-domain preview from the SAME colorizer used for XYZ tiles.
    # Nearest-neighbor preserves the actual radar bins and makes this a clean
    # Mapbox-independent check of the renderer.
    max_preview_width = 1600
    stride = max(1, int(np.ceil(grid.shape[1] / max_preview_width)))
    sampled = grid[::stride, ::stride]
    rgba = mrms.colorize_dbz_grid_for_tiles(sampled)
    preview = Image.fromarray(rgba, mode="RGBA")
    preview_path = output_root / "diagnostic-preview.png"
    preview.save(preview_path, format="PNG", optimize=True)

    visible = rgba[..., 3] > 0
    strong = sampled >= 20.0
    print(f"\nPreview: {preview.width} x {preview.height}")
    print(f"Preview visible pixels: {int(np.count_nonzero(visible)):,}")
    print(f"Preview >=20 dBZ pixels: {int(np.count_nonzero(strong & np.isfinite(sampled))):,}")
    print(f"Saved: {preview_path}")
    print("Open that PNG directly in the browser. If it is colored, the Python renderer is correct and the remaining issue is Mapbox/display-side.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
