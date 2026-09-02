#!/usr/bin/env python3
"""Render one native-resolution MRMS frame into a small fixed chunk grid.

The rolling loop deliberately uses a 4096px national texture for fast playback.
This module preserves the source grid for the newest frame by splitting it into
GPU-safe lossless WebP chunks. A browser only downloads chunks intersecting the
current viewport, so close-up quality improves without publishing a costly
slippy-map pyramid for every historical observation.
"""

from __future__ import annotations

from datetime import UTC, datetime
import gzip
import json
import math
from pathlib import Path
import shutil
import tempfile
import time

from PIL import Image

import render_mrms_mosaic as mrms


def _chunk_bounds(bounds, width, height, x0, y0, x1, y1):
    west, south, east, north = map(float, bounds)
    lon_span = east - west
    lat_span = north - south
    return [
        west + lon_span * (x0 / width),
        north - lat_span * (y1 / height),
        west + lon_span * (x1 / width),
        north - lat_span * (y0 / height),
    ]


def render_native_chunks(session, source, output_root: Path, chunk_pixels: int = 2048):
    output_root = Path(output_root)
    revision = str(source["slug"])
    revision_root = output_root / "revisions" / revision
    revision_manifest = revision_root / "revision.json"

    if revision_manifest.exists():
        return json.loads(revision_manifest.read_text(encoding="utf-8"))

    started = time.monotonic()
    chunk_pixels = max(512, int(chunk_pixels))

    response = session.get(source["url"], timeout=45)
    response.raise_for_status()

    with tempfile.TemporaryDirectory(prefix="mrms-native-detail-") as temp_name:
        temp_root = Path(temp_name)
        gz_path = temp_root / source["name"]
        grib_path = temp_root / source["name"].removesuffix(".gz")
        gz_path.write_bytes(response.content)
        with gzip.open(gz_path, "rb") as compressed, grib_path.open("wb") as target:
            shutil.copyfileobj(compressed, target)
        decoded = mrms.decode_mrms_grib2(grib_path)

    grid = decoded["grid"]
    height, width = grid.shape
    cols = int(math.ceil(width / chunk_pixels))
    rows = int(math.ceil(height / chunk_pixels))
    staging = output_root / "revisions" / f".{revision}.building"

    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    chunks = []
    try:
        for row in range(rows):
            y0 = row * chunk_pixels
            y1 = min(height, y0 + chunk_pixels)
            for col in range(cols):
                x0 = col * chunk_pixels
                x1 = min(width, x0 + chunk_pixels)
                chunk_id = f"r{row}-c{col}"
                relative_image = f"revisions/{revision}/chunks/{chunk_id}.webp"
                image_path = staging / "chunks" / f"{chunk_id}.webp"
                image_path.parent.mkdir(parents=True, exist_ok=True)

                rgba = mrms.colorize_dbz_grid_for_tiles(
                    grid[y0:y1, x0:x1],
                    mrms.NODATA,
                )
                Image.fromarray(rgba, mode="RGBA").save(
                    image_path,
                    format="WEBP",
                    lossless=True,
                    method=4,
                )
                chunks.append(
                    {
                        "id": chunk_id,
                        "image": relative_image,
                        "bounds": [
                            round(value, 8)
                            for value in _chunk_bounds(
                                decoded["bounds"],
                                width,
                                height,
                                x0,
                                y0,
                                x1,
                                y1,
                            )
                        ],
                        "width": int(x1 - x0),
                        "height": int(y1 - y0),
                        "row": row,
                        "column": col,
                    }
                )

        valid_time = decoded["valid_time"] or source["filename_time"]
        manifest = {
            "revision": revision,
            "generatedAt": datetime.now(UTC).isoformat(),
            "validTime": valid_time.isoformat(),
            "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
            "sourceName": source["name"],
            "mode": "native-grid-chunks",
            "bounds": list(map(float, decoded["bounds"])),
            "nativeWidth": int(width),
            "nativeHeight": int(height),
            "chunkPixels": chunk_pixels,
            "rows": rows,
            "columns": cols,
            "chunkCount": len(chunks),
            "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
            "grid": {
                "width": int(decoded["nx"]),
                "height": int(decoded["ny"]),
                "lonIncrement": decoded["di"],
                "latIncrement": decoded["dj"],
            },
            "chunks": chunks,
            "renderSeconds": round(time.monotonic() - started, 2),
        }
        (staging / "revision.json").write_text(
            json.dumps(manifest, indent=2),
            encoding="utf-8",
        )
        if revision_root.exists():
            shutil.rmtree(revision_root, ignore_errors=True)
        staging.replace(revision_root)
        return manifest
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
