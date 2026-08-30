#!/usr/bin/env python3
"""Pre-render one immutable, site-derived NEXRAD radar pyramid per radar scan.

The expensive radar work happens here, never in response to a user's pan/zoom.
For each new scan:
  1. render the native-detail max-zoom tile set from individual Level III N0B sites;
  2. derive lower zooms by downscaling those finished tiles;
  3. write everything into a revision directory;
  4. atomically switch manifest.json only after the revision is complete.

The browser then reads static WebPs through the ordinary site server.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import sys
import time

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

import serve_nexrad_detail_tiles as tile_renderer  # noqa: E402

DEFAULT_OUTPUT = REPO_ROOT / "nexrad-static-pyramid-output"
DEFAULT_BOUNDS = (-130.0, 20.0, -60.0, 55.0)
DEFAULT_MIN_ZOOM = 5
DEFAULT_MAX_ZOOM = 7
DEFAULT_TILE_SIZE = 1024
DEFAULT_WORKERS = 2
DEFAULT_KEEP_REVISIONS = 2


def _tile_x(lon: float, z: int) -> int:
    n = 2 ** z
    return max(0, min(n - 1, int(math.floor((lon + 180.0) / 360.0 * n))))


def _tile_y(lat: float, z: int) -> int:
    n = 2 ** z
    clamped = max(-85.05112878, min(85.05112878, float(lat)))
    rad = math.radians(clamped)
    return max(0, min(n - 1, int(math.floor((1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n))))


def tile_range(bounds, z: int):
    west, south, east, north = map(float, bounds)
    x0, x1 = sorted((_tile_x(west, z), _tile_x(east, z)))
    y0, y1 = sorted((_tile_y(north, z), _tile_y(south, z)))
    return range(x0, x1 + 1), range(y0, y1 + 1)


def revision_id(source: dict) -> str:
    stamp = source.get("timestamp")
    if stamp is not None:
        if getattr(stamp, "tzinfo", None) is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = str(source.get("dataset_name") or "scan")
    digits = "".join(ch for ch in name if ch.isdigit())
    return digits[-14:] or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def render_native_tiles(engine, revision_dir: Path, bounds, z: int, workers: int):
    xs, ys = tile_range(bounds, z)
    jobs = [(z, x, y) for y in ys for x in xs]
    total = len(jobs)
    done = 0
    started = time.time()

    print(f"Rendering native-detail z{z}: {total} tiles @ {engine.tile_size}px")

    def work(job):
        tz, tx, ty = job
        payload, meta = engine.render_tile(tz, tx, ty)
        path = revision_dir / "tiles" / str(tz) / str(tx) / f"{ty}.webp"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return meta

    metas = []
    with ThreadPoolExecutor(max_workers=max(1, int(workers))) as pool:
        futures = {pool.submit(work, job): job for job in jobs}
        for future in as_completed(futures):
            job = futures[future]
            try:
                metas.append(future.result())
            except Exception:
                for other in futures:
                    other.cancel()
                raise
            done += 1
            elapsed = max(0.001, time.time() - started)
            rate = done / elapsed
            eta = (total - done) / rate if rate > 0 else 0
            print(f"z{z}: {done}/{total} tiles | {rate:.2f}/s | ETA {eta/60:.1f} min", end="\r", flush=True)
    print()
    return metas


def derive_parent_zoom(revision_dir: Path, child_z: int, parent_z: int, bounds, tile_size: int):
    xs, ys = tile_range(bounds, parent_z)
    half = tile_size // 2
    resample = Image.Resampling.NEAREST
    count = 0

    print(f"Deriving z{parent_z} from completed z{child_z} tiles...")
    for y in ys:
        for x in xs:
            canvas = Image.new("RGBA", (tile_size, tile_size), (0, 0, 0, 0))
            for dy in (0, 1):
                for dx in (0, 1):
                    child_x = x * 2 + dx
                    child_y = y * 2 + dy
                    child_path = revision_dir / "tiles" / str(child_z) / str(child_x) / f"{child_y}.webp"
                    if not child_path.exists():
                        continue
                    with Image.open(child_path) as child:
                        piece = child.convert("RGBA").resize((half, half), resample=resample)
                    canvas.paste(piece, (dx * half, dy * half))
            out = revision_dir / "tiles" / str(parent_z) / str(x) / f"{y}.webp"
            out.parent.mkdir(parents=True, exist_ok=True)
            canvas.save(out, "WEBP", lossless=True, method=4)
            count += 1
    return count


def cleanup_old_revisions(output_dir: Path, keep: int, current_revision: str):
    revisions_dir = output_dir / "revisions"
    if not revisions_dir.exists():
        return
    dirs = [p for p in revisions_dir.iterdir() if p.is_dir() and p.name != current_revision]
    dirs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for old in dirs[max(0, keep - 1):]:
        print(f"Removing old radar revision {old.name}")
        shutil.rmtree(old, ignore_errors=True)


def build(args):
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    bounds = tuple(map(float, args.bounds))

    engine = tile_renderer.RadarTileEngine(
        tile_size=args.tile_size,
        refresh_seconds=24 * 3600,
        cache_tiles=8,
        max_sites_per_tile=18,
    )

    # Resolve the scan before creating output. A revision is immutable once built.
    _, source = engine._get_national()
    revision = revision_id(source)
    revision_dir = output_dir / "revisions" / revision
    manifest_path = output_dir / "manifest.json"

    if revision_dir.exists() and not args.force:
        print(f"Revision {revision} already exists; leaving it unchanged")
        if manifest_path.exists():
            return json.loads(manifest_path.read_text(encoding="utf-8"))

    staging = output_dir / "revisions" / f".{revision}.building"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    started = time.time()
    try:
        metas = render_native_tiles(engine, staging, bounds, args.max_zoom, args.workers)
        tile_counts = {str(args.max_zoom): len(metas)}

        child_z = args.max_zoom
        for parent_z in range(args.max_zoom - 1, args.min_zoom - 1, -1):
            tile_counts[str(parent_z)] = derive_parent_zoom(
                staging,
                child_z,
                parent_z,
                bounds,
                args.tile_size,
            )
            child_z = parent_z

        build_seconds = time.time() - started
        manifest = {
            "revision": revision,
            "source": "Pre-rendered individual-site NEXRAD N0B pyramid",
            "sourceDataset": source.get("dataset_name"),
            "validTime": source.get("timestamp").isoformat() if source.get("timestamp") else None,
            "builtAt": datetime.now(timezone.utc).isoformat(),
            "buildSeconds": round(build_seconds, 2),
            "bounds": list(bounds),
            "tileSize": int(args.tile_size),
            "minZoom": int(args.min_zoom),
            "maxZoom": int(args.max_zoom),
            "nativeZoom": int(args.max_zoom),
            "tileTemplate": f"revisions/{revision}/tiles/{{z}}/{{x}}/{{y}}.webp",
            "tileCounts": tile_counts,
            "stationCount": len(engine.station_table),
            "colorOwner": "Python / Zacharologist Level II palette",
            "renderPolicy": "One complete immutable pyramid per radar scan; browser reads static files only",
        }
        (staging / "revision.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        if revision_dir.exists():
            shutil.rmtree(revision_dir, ignore_errors=True)
        staging.replace(revision_dir)

        temp_manifest = output_dir / ".manifest.json.tmp"
        temp_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        temp_manifest.replace(manifest_path)
        cleanup_old_revisions(output_dir, args.keep_revisions, revision)

        print(f"Published static radar revision {revision} in {build_seconds/60:.1f} min")
        print(f"Manifest: {manifest_path}")
        return manifest
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--bounds", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"), default=DEFAULT_BOUNDS)
    parser.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM)
    parser.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--keep-revisions", type=int, default=DEFAULT_KEEP_REVISIONS)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    build(parse_args())
