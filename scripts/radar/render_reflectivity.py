#!/usr/bin/env python3
"""
Future Level III reflectivity renderer scaffold.

This script is intentionally non-rendering for now. Current website radar still
uses Windy/IEM, and custom frames remain inactive until the backend is real and
`USE_CUSTOM_RADAR_FRAMES` is explicitly enabled.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "radar_config.json"
REPO_ROOT = SCRIPT_DIR.parents[1]


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scaffold for rendering Level III N0B reflectivity frames."
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--source-cache",
        type=Path,
        default=REPO_ROOT / "radar" / "source" / "level3",
        help="Directory containing raw public Level III .nids source files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print intended work without creating frame images.",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    print("Reflectivity renderer scaffold")
    print(f"enabled={config.get('enabled')}")
    print(f"palette={config.get('palette')}")
    print(f"frameOutputDir={config.get('frameOutputDir')}")

    if not config.get("enabled"):
        print("Renderer is disabled; no frames will be rendered.")
        return 0

    if args.dry_run:
        print("Dry run: would decode Level III N0B and render transparent frames.")
        return 0

    source_files = sorted(args.source_cache.glob("Level3_*_N0B_*.nids"))

    if not source_files:
        print(f"No Level III N0B source files found in {args.source_cache}.")
        return 1

    print(f"Found source file: {source_files[-1]}")
    print("Real rendering is not implemented yet; no fake radar image was created.")
    print("Needed decoder path: MetPy Level3File or an equivalent NIDS Level III decoder, plus numpy and Pillow.")

    # TODO: Decode NOAA/Unidata Level III N0B source files.
    # TODO: Apply DEFAULT_REFLECTIVITY_COLOR_TABLE from the frontend contract.
    # TODO: Render transparent WebP or PNG frames.
    # TODO: Calculate geographic bounds for each output image.
    # TODO: Write frames to radar/frames/{site}/{product}/{slug}.webp.
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
