#!/usr/bin/env python3
"""Render one MRMS observation into a paired overview + native-detail bundle.

One NOAA GRIB download and one ecCodes decode feed both products. This keeps the
overview and detail timelines identical and removes duplicate decode work.
"""

from __future__ import annotations

from datetime import UTC, datetime
import gzip
import math
from pathlib import Path
import shutil
import tempfile
import time

import numpy as np
from PIL import Image

import render_mrms_loop as base
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


def _download_decode(session, source: dict):
    response = session.get(source["url"], timeout=45)
    response.raise_for_status()

    with tempfile.TemporaryDirectory(prefix="mrms-frame-bundle-") as temp_name:
        temp_root = Path(temp_name)
        gz_path = temp_root / source["name"]
        grib_path = temp_root / source["name"].removesuffix(".gz")
        gz_path.write_bytes(response.content)
        with gzip.open(gz_path, "rb") as compressed, grib_path.open("wb") as target:
            shutil.copyfileobj(compressed, target)
        return mrms.decode_mrms_grib2(grib_path)


def render_frame_bundle(
    session,
    source: dict,
    output_root: Path,
    max_width: int = 4096,
    chunk_pixels: int = 1024,
) -> dict:
    """Create both browser products for one observation from one decoded grid."""
    started = time.monotonic()
    output_root = Path(output_root)
    revision = str(source["slug"])
    decoded = _download_decode(session, source)

    grid = decoded["grid"]
    finite = grid[grid != mrms.NODATA]
    if not finite.size:
        raise RuntimeError(f"{source['name']} decoded with no valid reflectivity")

    valid_time = decoded["valid_time"] or source["filename_time"]

    # Overview product: one inexpensive national/regional texture.
    overview_dir = output_root / "frames"
    overview_dir.mkdir(parents=True, exist_ok=True)
    sampled = base.downsample_nearest(grid, max(512, int(max_width)))
    overview_rgba = mrms.colorize_dbz_grid_for_tiles(sampled, mrms.NODATA)
    overview_path = overview_dir / f"{revision}.webp"
    Image.fromarray(overview_rgba, mode="RGBA").save(
        overview_path,
        format="WEBP",
        lossless=True,
        method=4,
    )

    overview = {
        "id": revision,
        "valid_time": valid_time.isoformat(),
        "image": f"frames/{overview_path.name}",
        "source_name": source["name"],
        "minDbz": float(finite.min()),
        "maxDbz": float(finite.max()),
        "detailRevision": revision,
    }

    # Native product: preserve every MRMS source-grid sample and split it only
    # for GPU-safe loading. Each chunk remains lossless WebP.
    chunk_pixels = max(512, int(chunk_pixels))
    height, width = grid.shape
    columns = int(math.ceil(width / chunk_pixels))
    rows = int(math.ceil(height / chunk_pixels))
    native_root = output_root / "native-detail"
    revision_root = native_root / "revisions" / revision
    if revision_root.exists():
        shutil.rmtree(revision_root, ignore_errors=True)
    chunks_dir = revision_root / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    chunks = []
    for row in range(rows):
        y0 = row * chunk_pixels
        y1 = min(height, y0 + chunk_pixels)
        for column in range(columns):
            x0 = column * chunk_pixels
            x1 = min(width, x0 + chunk_pixels)
            chunk_id = f"r{row}-c{column}"
            relative_image = f"revisions/{revision}/chunks/{chunk_id}.webp"
            image_path = chunks_dir / f"{chunk_id}.webp"

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
                    "column": column,
                }
            )

    detail = {
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
        "columns": columns,
        "chunkCount": len(chunks),
        "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
        "grid": {
            "width": int(decoded["nx"]),
            "height": int(decoded["ny"]),
            "lonIncrement": decoded["di"],
            "latIncrement": decoded["dj"],
        },
        "chunks": chunks,
    }

    return {
        "overview": overview,
        "overview_path": overview_path,
        "overview_width": int(sampled.shape[1]),
        "overview_height": int(sampled.shape[0]),
        "bounds": list(map(float, decoded["bounds"])),
        "detail": detail,
        "native_root": native_root,
        "renderSeconds": round(time.monotonic() - started, 2),
    }
