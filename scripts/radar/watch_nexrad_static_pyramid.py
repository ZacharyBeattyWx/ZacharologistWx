#!/usr/bin/env python3
"""Rebuild the static NEXRAD pyramid only when a new radar scan appears."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

import render_unidata_nexrad_mosaic as national_renderer  # noqa: E402

DEFAULT_OUTPUT = REPO_ROOT / "nexrad-static-pyramid-output"


def current_dataset(output_dir: Path):
    manifest = output_dir / "manifest.json"
    if not manifest.exists():
        return None
    try:
        return json.loads(manifest.read_text(encoding="utf-8")).get("sourceDataset")
    except Exception:
        return None


def latest_dataset(session: requests.Session):
    source = national_renderer.discover_latest_gini(session, "n0b")
    return source.get("dataset_name"), source


def run_builder(args):
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "build_nexrad_static_pyramid.py"),
        "--output",
        str(Path(args.output).resolve()),
        "--min-zoom",
        str(args.min_zoom),
        "--max-zoom",
        str(args.max_zoom),
        "--tile-size",
        str(args.tile_size),
        "--workers",
        str(args.workers),
        "--keep-revisions",
        str(args.keep_revisions),
    ]
    if args.force:
        cmd.append("--force")
    print("Launching static radar build...")
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--poll-seconds", type=int, default=30)
    parser.add_argument("--min-zoom", type=int, default=5)
    parser.add_argument("--max-zoom", type=int, default=7)
    parser.add_argument("--tile-size", type=int, default=1024)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--keep-revisions", type=int, default=2)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output).resolve()
    session = requests.Session()
    session.headers.update({"User-Agent": "ZacharologistWx/NEXRAD-static-pyramid-watch"})

    print("Static NEXRAD pyramid watcher")
    print(f"Output: {output_dir}")
    print(f"Polling for a new N0B scan every {args.poll_seconds}s")
    print("Pan/zoom requests never trigger radar rendering in this mode.")

    while True:
        try:
            published = current_dataset(output_dir)
            latest, source = latest_dataset(session)
            if not latest:
                print("No latest N0B dataset discovered; retrying")
            elif published != latest:
                print(f"New radar scan: {latest} (published={published or 'none'})")
                started = time.time()
                run_builder(args)
                print(f"Refresh build finished in {(time.time() - started)/60:.1f} min")
            else:
                print(f"No new scan: {latest}", end="\r", flush=True)
        except KeyboardInterrupt:
            print("\nStopping static radar watcher")
            return
        except Exception as exc:
            print(f"\nWatcher error: {exc}")

        time.sleep(max(10, args.poll_seconds))


if __name__ == "__main__":
    main()
