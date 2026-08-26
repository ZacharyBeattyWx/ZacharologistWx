#!/usr/bin/env python3
"""Build a time-window-based playable national MRMS reflectivity loop.

The renderer intentionally preserves the radar path that proved visually correct:
- NOAA numeric MRMS ReflectivityAtLowestAltitude GRIB2
- the same Python dBZ -> RGBA colorizer used by the Level II radar
- lossless WebP observations
- browser playback swaps those already-colored images into one custom WebGL texture

The loop is defined by elapsed time, not by a fixed frame count. By default the
latest 60 minutes of available MRMS observations are retained in the playback
manifest. Existing timestamped WebP images are reused on later runs, so normally
only the newest one or two MRMS scans need to be downloaded/rendered.
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
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin

import numpy as np
import requests
from PIL import Image

import render_mrms_mosaic as mrms

REPO_ROOT = mrms.REPO_ROOT
DEFAULT_OUTPUT = REPO_ROOT / "mrms-mosaic-loop-output"
DEFAULT_WINDOW_MINUTES = 60
DEFAULT_RETAIN_MINUTES = 90
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


def list_recent_sources(session: requests.Session, window_minutes: int) -> list[dict]:
    print(f"Listing {MRMS_DIRECTORY_URL}", flush=True)
    response = session.get(MRMS_DIRECTORY_URL, timeout=45)
    response.raise_for_status()

    filenames = sorted(
        {match.group(0) for match in HISTORICAL_NAME_RE.finditer(html.unescape(response.text))},
        key=timestamp_from_name,
    )
    if not filenames:
        raise RuntimeError("NOAA MRMS directory did not contain timestamped reflectivity files")

    newest_time = timestamp_from_name(filenames[-1])
    cutoff = newest_time - timedelta(minutes=max(1, int(window_minutes)))
    selected = [name for name in filenames if timestamp_from_name(name) >= cutoff]

    # Guarantee a usable loop even during an unusual listing gap.
    if len(selected) < 2:
        selected = filenames[-2:]

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


def parse_slug_time(slug: str) -> datetime | None:
    try:
        return datetime.strptime(slug, "%Y%m%d-%H%M%S").replace(tzinfo=UTC)
    except ValueError:
        return None


def prune_old_files(
    frames_dir: Path,
    meta_dir: Path,
    keep_ids: set[str],
    newest_time: datetime,
    retain_minutes: int,
) -> None:
    retain_cutoff = newest_time - timedelta(minutes=max(1, int(retain_minutes)))

    for path in frames_dir.glob("*.webp"):
        frame_time = parse_slug_time(path.stem)
        if path.stem in keep_ids:
            continue
        if frame_time is not None and frame_time >= retain_cutoff:
            continue
        path.unlink(missing_ok=True)
        (meta_dir / f"{path.stem}.json").unlink(missing_ok=True)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument(
        "--minutes",
        type=int,
        default=DEFAULT_WINDOW_MINUTES,
        help="Playback history window in minutes (default: 60)",
    )
    parser.add_argument(
        "--retain-minutes",
        type=int,
        default=DEFAULT_RETAIN_MINUTES,
        help="Keep rendered observations this many minutes for fast reuse (default: 90)",
    )
    parser.add_argument("--max-width", type=int, default=DEFAULT_MAX_WIDTH)
    return parser.parse_args()


def main():
    args = parse_args()
    window_minutes = max(5, int(args.minutes))
    retain_minutes = max(window_minutes, int(args.retain_minutes))
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

    sources = list_recent_sources(session, window_minutes)
    actual_span_minutes = (
        sources[-1]["filename_time"] - sources[0]["filename_time"]
    ).total_seconds() / 60.0
    print(
        f"Selected {len(sources)} observations covering {actual_span_minutes:.1f} minutes: "
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

    compatible_frames = [
        frame for frame in frames
        if frame.get("bounds") == bounds
        and int(frame.get("imageWidth", 0)) == int(width)
        and int(frame.get("imageHeight", 0)) == int(height)
    ]
    if len(compatible_frames) < 2:
        raise RuntimeError("Fewer than two compatible MRMS observations were rendered")

    start_time = datetime.fromisoformat(compatible_frames[0]["valid_time"])
    end_time = datetime.fromisoformat(compatible_frames[-1]["valid_time"])
    span_minutes = max(0.0, (end_time - start_time).total_seconds() / 60.0)

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
        "historyWindowMinutes": window_minutes,
        "actualSpanMinutes": round(span_minutes, 2),
        "startTime": start_time.isoformat(),
        "endTime": end_time.isoformat(),
        "observationCount": len(compatible_frames),
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
    prune_old_files(
        frames_dir,
        meta_dir,
        keep_ids,
        end_time,
        retain_minutes,
    )

    reused = sum(1 for frame in compatible_frames if frame.get("reused"))
    rendered = len(compatible_frames) - reused
    print(
        f"Done: {span_minutes:.1f}-minute loop with {len(compatible_frames)} observations "
        f"({rendered} rendered, {reused} reused) -> {output_root}",
        flush=True,
    )
    print(f"Revision: {revision}", flush=True)


if __name__ == "__main__":
    main()
