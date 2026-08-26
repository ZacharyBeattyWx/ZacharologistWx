#!/usr/bin/env python3
"""Build a short playable national MRMS reflectivity loop.

The renderer intentionally preserves the radar path that proved visually correct:
- NOAA numeric MRMS ReflectivityAtLowestAltitude GRIB2
- the same Python dBZ -> RGBA colorizer used by the Level II radar
- lossless WebP frames
- browser playback swaps those already-colored images into one custom WebGL texture

The loop is incremental. Existing timestamped WebP frames are reused on later runs,
so normally only the newest one or two MRMS scans need to be downloaded/rendered.
"""

from __future__ import annotations

import argparse
import gzip
import html
import json
import re
import shutil
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urljoin

import numpy as np
import requests
from PIL import Image

import render_mrms_mosaic as mrms

REPO_ROOT = mrms.REPO_ROOT
DEFAULT_OUTPUT = REPO_ROOT / "mrms-mosaic-loop-output"
DEFAULT_FRAME_COUNT = 12
DEFAULT_RETAIN_COUNT = 18
DEFAULT_MAX_WIDTH = 4096
MRMS_DIRECTORY_URL = "https://mrms.ncep.noaa.gov/2D/ReflectivityAtLowestAltitude/"
HISTORICAL_NAME_RE = re.compile(
    r"MRMS_ReflectivityAtLowestAltitude_00\.50_(?P<stamp>\d{8}-\d{6})\.grib2\.gz"
)


def downsample_nearest(grid: np.ndarray, max_width: int) -> np.ndarray:
    """Limit texture size without inventing intermediate dBZ values."""
    height, width = grid.shape
    if width <= max_width:
        return grid

    scale = max_width / float(width)
    out_width = max(1, int(round(width * scale)))
    out_height = max(1, int(round(height * scale)))
    x_idx = np.linspace(0, width - 1, out_width).round().astype(np.int32)
    y_idx = np.linspace(0, height - 1, out_height).round().astype(np.int32)
    return grid[np.ix_(y_idx, x_idx)]


def timestamp_from_name(name: str) -> datetime:
    match = HISTORICAL_NAME_RE.fullmatch(name)
    if not match:
        raise ValueError(f"Unexpected MRMS filename: {name}")
    return datetime.strptime(match.group("stamp"), "%Y%m%d-%H%M%S").replace(tzinfo=UTC)


def frame_slug_from_name(name: str) -> str:
    match = HISTORICAL_NAME_RE.fullmatch(name)
    if not match:
        raise ValueError(f"Unexpected MRMS filename: {name}")
    return match.group("stamp")


def list_recent_sources(session: requests.Session, count: int) -> list[dict]:
    print(f"Listing {MRMS_DIRECTORY_URL}", flush=True)
    response = session.get(MRMS_DIRECTORY_URL, timeout=45)
    response.raise_for_status()

    # Apache directory listings are plain HTML. Parsing hrefs with this narrow
    # product-specific regex is more robust here than depending on table layout.
    names = sorted(set(HISTORICAL_NAME_RE.findall(response.text)))
    # findall() returns only the named capture when a named group is present,
    # so use finditer() to recover full filenames.
    filenames = sorted(
        {match.group(0) for match in HISTORICAL_NAME_RE.finditer(html.unescape(response.text))},
        key=timestamp_from_name,
    )

    if not filenames:
        raise RuntimeError("NOAA MRMS directory did not contain timestamped reflectivity files")

    selected = filenames[-max(1, int(count)) :]
    return [
        {
            "name": name,
            "url": urljoin(MRMS_DIRECTORY_URL, name),
            "filename_time": timestamp_from_name(name),
            "slug": frame_slug_from_name(name),
        }
        for name in selected
    ]


def read_frame_meta(meta_path: Path) -> dict | None:
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_frame_meta(meta_path: Path, payload: dict) -> None:
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def render_source_frame(
    session: requests.Session,
    source: dict,
    frames_dir: Path,
    meta_dir: Path,
    max_width: int,
) -> dict:
    slug = source["slug"]
    image_path = frames_dir / f"{slug}.webp"
    meta_path = meta_dir / f"{slug}.json"

    cached_meta = read_frame_meta(meta_path)
    if image_path.exists() and cached_meta:
        cached_meta["reused"] = True
        print(f"Reuse {image_path.name}", flush=True)
        return cached_meta

    print(f"Download {source['name']}", flush=True)
    response = session.get(source["url"], timeout=45)
    response.raise_for_status()

    with tempfile.TemporaryDirectory(prefix="mrms-loop-frame-") as temp_name:
        temp_root = Path(temp_name)
        gz_path = temp_root / source["name"]
        grib_path = temp_root / source["name"].removesuffix(".gz")
        gz_path.write_bytes(response.content)

        with gzip.open(gz_path, "rb") as compressed, grib_path.open("wb") as target:
            shutil.copyfileobj(compressed, target)

        decoded = mrms.decode_mrms_grib2(grib_path)

    grid = decoded["grid"]
    finite = grid[grid != mrms.NODATA]
    if not finite.size:
        raise RuntimeError(f"{source['name']} decoded with no valid reflectivity")

    sampled = downsample_nearest(grid, max(256, int(max_width)))
    rgba = mrms.colorize_dbz_grid_for_tiles(sampled, mrms.NODATA)

    frames_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(
        image_path,
        format="WEBP",
        lossless=True,
        method=4,
    )

    valid_time = decoded["valid_time"] or source["filename_time"]
    payload = {
        "id": slug,
        "valid_time": valid_time.isoformat(),
        "image": f"frames/{image_path.name}",
        "source_name": source["name"],
        "source_url": source["url"],
        "bounds": list(decoded["bounds"]),
        "imageWidth": int(sampled.shape[1]),
        "imageHeight": int(sampled.shape[0]),
        "minDbz": float(finite.min()),
        "maxDbz": float(finite.max()),
        "visiblePixels": int(np.count_nonzero(rgba[..., 3])),
        "reused": False,
    }
    write_frame_meta(meta_path, payload)

    print(
        f"Rendered {image_path.name}: {sampled.shape[1]}x{sampled.shape[0]} "
        f"dBZ={float(finite.min()):.1f}..{float(finite.max()):.1f}",
        flush=True,
    )
    return payload


def prune_old_files(frames_dir: Path, meta_dir: Path, keep_ids: set[str], retain_count: int) -> None:
    all_frames = sorted(frames_dir.glob("*.webp"), key=lambda path: path.stem)
    protected = {path.stem for path in all_frames[-max(1, retain_count) :]} | keep_ids

    for path in all_frames:
        if path.stem not in protected:
            path.unlink(missing_ok=True)
            (meta_dir / f"{path.stem}.json").unlink(missing_ok=True)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--frames", type=int, default=DEFAULT_FRAME_COUNT)
    parser.add_argument("--retain", type=int, default=DEFAULT_RETAIN_COUNT)
    parser.add_argument("--max-width", type=int, default=DEFAULT_MAX_WIDTH)
    return parser.parse_args()


def main():
    args = parse_args()
    frame_count = max(2, int(args.frames))
    retain_count = max(frame_count, int(args.retain))
    max_width = max(512, int(args.max_width))

    output_root = Path(args.output).resolve()
    frames_dir = output_root / "frames"
    meta_dir = output_root / "meta"
    output_root.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers.update({
        "User-Agent": mrms.USER_AGENT,
        "Accept": "*/*",
        "Cache-Control": "no-cache",
    })

    sources = list_recent_sources(session, frame_count)
    print(
        f"Selected {len(sources)} frames: "
        f"{sources[0]['filename_time'].isoformat()} -> {sources[-1]['filename_time'].isoformat()}",
        flush=True,
    )

    frames = []
    for index, source in enumerate(sources, start=1):
        print(f"[{index}/{len(sources)}]", flush=True)
        frames.append(
            render_source_frame(
                session,
                source,
                frames_dir,
                meta_dir,
                max_width,
            )
        )

    frames.sort(key=lambda frame: frame["valid_time"])
    bounds = frames[-1]["bounds"]
    width = frames[-1]["imageWidth"]
    height = frames[-1]["imageHeight"]

    # Guard against a malformed/inconsistent source frame entering playback.
    compatible_frames = [
        frame for frame in frames
        if frame.get("bounds") == bounds
        and int(frame.get("imageWidth", 0)) == int(width)
        and int(frame.get("imageHeight", 0)) == int(height)
    ]
    if len(compatible_frames) < 2:
        raise RuntimeError("Fewer than two compatible MRMS frames were rendered")

    now = datetime.now(UTC)
    revision = int(time.time())
    manifest = {
        "generated_at": now.isoformat(),
        "revision": revision,
        "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
        "units": "dBZ",
        "bounds": bounds,
        "imageWidth": width,
        "imageHeight": height,
        "palette": str(mrms.PALETTE_FILE.relative_to(REPO_ROOT)).replace("\\", "/"),
        "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
        "frameCount": len(compatible_frames),
        "defaultFrameIntervalMs": 650,
        "frames": [
            {
                key: frame[key]
                for key in ("id", "valid_time", "image", "source_name", "minDbz", "maxDbz")
            }
            for frame in compatible_frames
        ],
    }
    (output_root / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )

    keep_ids = {frame["id"] for frame in compatible_frames}
    prune_old_files(frames_dir, meta_dir, keep_ids, retain_count)

    reused = sum(1 for frame in compatible_frames if frame.get("reused"))
    rendered = len(compatible_frames) - reused
    print(
        f"Done: {len(compatible_frames)} loop frames ({rendered} rendered, {reused} reused) "
        f"-> {output_root}",
        flush=True,
    )
    print(f"Revision: {revision}", flush=True)


if __name__ == "__main__":
    main()
