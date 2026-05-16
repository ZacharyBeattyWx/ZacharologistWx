#!/usr/bin/env python3
"""
Safe placeholder for pruning generated radar frames.

By default this script only prints what it would do. Pass --apply in a future
implementation when deletion behavior is fully reviewed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "radar_config.json"


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    parser = argparse.ArgumentParser(description="Dry-run-safe radar frame pruning scaffold.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--apply", action="store_true", help="Apply pruning in a future implementation.")
    args = parser.parse_args()

    config = load_config(args.config)
    frame_dir = Path(config.get("frameOutputDir", "radar/frames"))
    frame_count = int(config.get("frameCount", 6))

    print("Radar frame pruning scaffold")
    print(f"frameOutputDir={frame_dir}")
    print(f"would keep latest {frame_count} frames per site/product")

    if not args.apply:
        print("Dry run only. No files were deleted.")
        return 0

    # TODO: Implement safe pruning after renderer output is real.
    print("--apply was provided, but pruning is not implemented yet. No files were deleted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
