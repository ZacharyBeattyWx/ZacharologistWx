#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import json
import re
import shutil
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import requests

import render_mrms_loop as loop
import render_mrms_mosaic as mrms

PRODUCT = "MergedReflectivityAtLowestAltitude"
PRODUCT_KEY = "mrala"

NUMERIC_NODATA_CODE = 0
NUMERIC_MIN_CODE = 1
NUMERIC_MAX_CODE = 255
NUMERIC_MIN_DBZ = -32.0
NUMERIC_STEP_DBZ = 0.5
NUMERIC_MAX_DBZ = NUMERIC_MIN_DBZ + (NUMERIC_MAX_CODE - NUMERIC_MIN_CODE) * NUMERIC_STEP_DBZ

def configure_source() -> None:
    loop.MRMS_DIRECTORY_URL = f"https://mrms.ncep.noaa.gov/2D/{PRODUCT}/"
    loop.HISTORICAL_NAME_RE = re.compile(
        rf"MRMS_{re.escape(PRODUCT)}_00\.50_(?P<stamp>\d{{8}}-\d{{6}})\.grib2\.gz"
    )

def encode_numeric_grid(grid: np.ndarray) -> np.ndarray:
    sampled = np.asarray(grid, dtype=np.float32)
    encoded = np.zeros(sampled.shape, dtype=np.uint8)
    valid = np.isfinite(sampled) & (sampled != mrms.NODATA) & (sampled > -9000.0)
    if not np.any(valid):
        return encoded
    clipped = np.clip(sampled[valid], NUMERIC_MIN_DBZ, NUMERIC_MAX_DBZ)
    codes = np.rint((clipped - NUMERIC_MIN_DBZ) / NUMERIC_STEP_DBZ).astype(np.int16) + NUMERIC_MIN_CODE
    encoded[valid] = np.clip(codes, NUMERIC_MIN_CODE, NUMERIC_MAX_CODE).astype(np.uint8)
    return encoded

def decode_source(session: requests.Session, source: dict) -> dict:
    response = session.get(source["url"], timeout=60)
    response.raise_for_status()
    with tempfile.TemporaryDirectory(prefix="mrms-native-numeric-") as temp_name:
        temp_root = Path(temp_name)
        gz_path = temp_root / source["name"]
        grib_path = temp_root / source["name"].removesuffix(".gz")
        gz_path.write_bytes(response.content)
        with gzip.open(gz_path, "rb") as compressed, grib_path.open("wb") as target:
            shutil.copyfileobj(compressed, target)
        return mrms.decode_mrms_grib2(grib_path)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--minutes", type=int, default=20)
    parser.add_argument("--max-frames", type=int, default=6)
    parser.add_argument("--compresslevel", type=int, default=4)
    args = parser.parse_args()

    configure_source()
    output_root = Path(args.output).resolve()
    shutil.rmtree(output_root, ignore_errors=True)
    frames_dir = output_root / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers.update({
        "User-Agent": mrms.USER_AGENT,
        "Accept": "*/*",
        "Cache-Control": "no-cache",
    })

    sources = loop.list_recent_sources(session, max(5, int(args.minutes)))
    if args.max_frames > 0:
        sources = sources[-int(args.max_frames):]

    frames = []
    geometry = None

    for index, source in enumerate(sources, start=1):
        print(f"[{index}/{len(sources)}] {source['name']}", flush=True)
        decoded = decode_source(session, source)
        grid = np.asarray(decoded["grid"], dtype=np.float32)
        valid = np.isfinite(grid) & (grid != mrms.NODATA) & (grid > -9000.0)
        if not np.any(valid):
            raise RuntimeError(f"{source['name']} decoded with no valid reflectivity")

        current_geometry = (
            tuple(float(x) for x in decoded["bounds"]),
            int(grid.shape[1]),
            int(grid.shape[0]),
        )
        if geometry is None:
            geometry = current_geometry
        elif current_geometry != geometry:
            raise RuntimeError(f"MRMS native geometry changed: {current_geometry} != {geometry}")

        encoded = encode_numeric_grid(grid)
        raw = np.ascontiguousarray(encoded, dtype=np.uint8).tobytes(order="C")
        compressed = gzip.compress(raw, compresslevel=max(1, min(9, int(args.compresslevel))))

        frame_id = source["slug"]
        (frames_dir / f"{frame_id}.dbz").write_bytes(compressed)

        valid_time = decoded["valid_time"] or source["filename_time"]
        frame = {
            "id": frame_id,
            "valid_time": valid_time.isoformat(),
            "dbz": f"frames/{frame_id}.dbz",
            "dbzRawBytes": len(raw),
            "dbzCompressedBytes": len(compressed),
            "source_name": source["name"],
            "product": PRODUCT,
            "productKey": PRODUCT_KEY,
            "minDbz": round(float(np.min(grid[valid])), 2),
            "maxDbz": round(float(np.max(grid[valid])), 2),
        }
        frames.append(frame)

        print(
            f"  native={grid.shape[1]}x{grid.shape[0]} "
            f"raw={len(raw)/1048576:.2f} MiB "
            f"gzip={len(compressed)/1048576:.2f} MiB "
            f"dBZ={frame['minDbz']}..{frame['maxDbz']}",
            flush=True,
        )

    if len(frames) < 2:
        raise RuntimeError("Need at least two numeric MRALA frames")

    frames.sort(key=lambda item: item["valid_time"])
    bounds, width, height = geometry
    start_time = datetime.fromisoformat(frames[0]["valid_time"])
    end_time = datetime.fromisoformat(frames[-1]["valid_time"])
    span_minutes = (end_time - start_time).total_seconds() / 60.0

    manifest = {
        "generated_at": datetime.now(UTC).isoformat(),
        "revision": int(time.time()),
        "mode": "mrms-native-numeric-texture-test",
        "source": f"NOAA/NCEP MRMS {PRODUCT}",
        "product": PRODUCT,
        "productKey": PRODUCT_KEY,
        "units": "dBZ",
        "bounds": list(bounds),
        "imageWidth": width,
        "imageHeight": height,
        "sourceGridWidth": width,
        "sourceGridHeight": height,
        "historyWindowMinutes": int(args.minutes),
        "actualSpanMinutes": round(span_minutes, 2),
        "observationCount": len(frames),
        "startTime": frames[0]["valid_time"],
        "endTime": frames[-1]["valid_time"],
        "numericEncoding": {
            "format": "uint8-dbz-grid-v1",
            "layout": "row-major",
            "compression": "gzip-http-content-encoding",
            "noDataCode": NUMERIC_NODATA_CODE,
            "minCode": NUMERIC_MIN_CODE,
            "maxCode": NUMERIC_MAX_CODE,
            "minDbz": NUMERIC_MIN_DBZ,
            "stepDbz": NUMERIC_STEP_DBZ,
            "maxDbz": NUMERIC_MAX_DBZ,
            "bytesPerPixel": 1,
        },
        "publisher": {
            "platform": "cloudshell-test",
            "strategy": "native-mrala-numeric-v1",
        },
        "frames": frames,
    }

    (output_root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    total_raw = sum(int(frame["dbzRawBytes"]) for frame in frames)
    total_compressed = sum(int(frame["dbzCompressedBytes"]) for frame in frames)

    print()
    print("DONE")
    print(f"Product: {PRODUCT}")
    print(f"Grid: {width}x{height}")
    print(f"Frames: {len(frames)}")
    print(f"Span: {span_minutes:.1f} min")
    print(f"Per-frame GPU: {width * height / 1048576:.2f} MiB")
    print(f"Transfer total: {total_compressed / 1048576:.2f} MiB gzip")
    print(f"Compression ratio: {total_compressed / max(1, total_raw):.3f}")

if __name__ == "__main__":
    main()
