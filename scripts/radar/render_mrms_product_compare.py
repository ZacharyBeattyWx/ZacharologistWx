#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import render_mrms_loop as loop
import render_mrms_mosaic as mrms

PRODUCTS = {
    "rala": "ReflectivityAtLowestAltitude",
    "mrala": "MergedReflectivityAtLowestAltitude",
    "mbr": "MergedBaseReflectivity",
}

def configure_product(key: str) -> str:
    key = key.lower().strip()
    if key not in PRODUCTS:
        raise SystemExit(f"Unknown product {key!r}; choose rala, mrala, or mbr")
    product = PRODUCTS[key]
    loop.MRMS_DIRECTORY_URL = f"https://mrms.ncep.noaa.gov/2D/{product}/"
    loop.HISTORICAL_NAME_RE = re.compile(
        rf"MRMS_{re.escape(product)}_00\.50_(?P<stamp>\d{{8}}-\d{{6}})\.grib2\.gz"
    )
    return product

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--product", required=True, choices=sorted(PRODUCTS))
    parser.add_argument("--output", required=True)
    parser.add_argument("--minutes", type=int, default=30)
    parser.add_argument("--max-frames", type=int, default=10)
    parser.add_argument("--max-width", type=int, default=4096)
    args = parser.parse_args()

    product = configure_product(args.product)
    output_root = Path(args.output).resolve()
    shutil.rmtree(output_root, ignore_errors=True)
    frames_dir = output_root / "frames"
    meta_dir = output_root / "meta"
    frames_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers.update({
        "User-Agent": mrms.USER_AGENT,
        "Accept": "*/*",
        "Cache-Control": "no-cache",
    })

    sources = loop.list_recent_sources(session, max(5, args.minutes))
    if args.max_frames > 0:
        sources = sources[-args.max_frames:]

    frames = []
    for index, source in enumerate(sources, start=1):
        print(
            f"[{args.product} {index}/{len(sources)}] {source['name']}",
            flush=True,
        )
        frame = loop.render_source_frame(
            session,
            source,
            frames_dir,
            meta_dir,
            max(512, args.max_width),
        )
        frame["product"] = product
        frame["productKey"] = args.product
        frames.append(frame)

    frames.sort(key=lambda frame: frame["valid_time"])
    if len(frames) < 2:
        raise RuntimeError("Need at least two frames for playback")

    bounds = frames[-1]["bounds"]
    width = frames[-1]["imageWidth"]
    height = frames[-1]["imageHeight"]

    compatible = [
        frame
        for frame in frames
        if frame.get("bounds") == bounds
        and int(frame.get("imageWidth", 0)) == int(width)
        and int(frame.get("imageHeight", 0)) == int(height)
    ]
    if len(compatible) < 2:
        raise RuntimeError("Fewer than two compatible MRMS frames")

    start_time = datetime.fromisoformat(compatible[0]["valid_time"])
    end_time = datetime.fromisoformat(compatible[-1]["valid_time"])
    span_minutes = (end_time - start_time).total_seconds() / 60.0

    manifest = {
        "generated_at": datetime.now(UTC).isoformat(),
        "revision": int(time.time()),
        "mode": "mrms-product-comparison",
        "source": f"NOAA/NCEP MRMS {product}",
        "product": product,
        "productKey": args.product,
        "units": "dBZ",
        "bounds": bounds,
        "imageWidth": width,
        "imageHeight": height,
        "palette": str(
            mrms.PALETTE_FILE.relative_to(mrms.REPO_ROOT)
        ).replace("\\", "/"),
        "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
        "historyWindowMinutes": args.minutes,
        "actualSpanMinutes": round(span_minutes, 2),
        "startTime": start_time.isoformat(),
        "endTime": end_time.isoformat(),
        "observationCount": len(compatible),
        "defaultFrameIntervalMs": 500,
        "frames": [
            {
                "id": frame["id"],
                "valid_time": frame["valid_time"],
                "image": frame["image"],
                "source_name": frame["source_name"],
                "minDbz": frame["minDbz"],
                "maxDbz": frame["maxDbz"],
                "product": product,
                "productKey": args.product,
            }
            for frame in compatible
        ],
    }

    (output_root / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )

    print(
        f"DONE {args.product}: {len(compatible)} frames • "
        f"{span_minutes:.1f} min • {width}x{height}",
        flush=True,
    )

if __name__ == "__main__":
    main()
