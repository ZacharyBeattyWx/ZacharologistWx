#!/usr/bin/env python3
"""Continuously refresh the local adaptive MRMS playback archive.

This is a development helper, not the eventual production scheduler. It reruns
the adaptive archive renderer on a fixed cadence. Existing timestamped WebP
observations are reused, so after the initial 24-hour backfill most passes only
need to process newly arrived MRMS observations.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RENDER_SCRIPT = SCRIPT_DIR / "render_mrms_loop_archive.py"
DEFAULT_MINUTES = 24 * 60
DEFAULT_RETAIN_MINUTES = 25 * 60


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--poll-seconds", type=int, default=60)
    parser.add_argument("--minutes", type=int, default=DEFAULT_MINUTES)
    parser.add_argument("--retain-minutes", type=int, default=DEFAULT_RETAIN_MINUTES)
    parser.add_argument("--max-width", type=int, default=4096)
    parser.add_argument("--output", default=None)
    return parser.parse_args()


def render_once(args) -> int:
    command = [
        sys.executable,
        str(RENDER_SCRIPT),
        "--minutes",
        str(max(5, int(args.minutes))),
        "--retain-minutes",
        str(max(int(args.minutes), int(args.retain_minutes))),
        "--max-width",
        str(max(512, int(args.max_width))),
    ]
    if args.output:
        command.extend(["--output", str(args.output)])

    started = time.monotonic()
    result = subprocess.run(command, check=False)
    elapsed = time.monotonic() - started
    print(
        f"MRMS archive refresh finished with exit code {result.returncode} in {elapsed:.1f}s",
        flush=True,
    )
    return result.returncode


def main():
    args = parse_args()
    poll_seconds = max(30, int(args.poll_seconds))
    minutes = max(5, int(args.minutes))
    hours = minutes / 60.0
    history_label = f"{hours:g} hours" if minutes >= 60 else f"{minutes} minutes"
    print(
        f"Watching adaptive MRMS archive: latest {history_label}, "
        f"refresh every {poll_seconds}s. Press Ctrl+C to stop.",
        flush=True,
    )

    try:
        while True:
            cycle_started = time.monotonic()
            render_once(args)
            elapsed = time.monotonic() - cycle_started
            delay = max(1.0, poll_seconds - elapsed)
            print(f"Next MRMS check in {delay:.0f}s", flush=True)
            time.sleep(delay)
    except KeyboardInterrupt:
        print("\nMRMS archive watcher stopped.", flush=True)


if __name__ == "__main__":
    main()
