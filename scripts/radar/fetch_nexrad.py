#!/usr/bin/env python3
"""
Future NOAA/Unidata NEXRAD fetch scaffold.

This script is not active on the website yet. Current live radar still uses
Windy/IEM. Future generated radar files must be site-owned and must not hotlink
or copy rendered frames from AgWx, Tehuano Labs, RadarScope, RadarOmega, or
other rendered radar products.
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
    parser = argparse.ArgumentParser(
        description="Scaffold for fetching public NOAA/Unidata NEXRAD data."
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print intended work without downloading data.",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    print("NEXRAD fetch scaffold")
    print(f"enabled={config.get('enabled')}")
    print(f"sites={', '.join(config.get('sites', []))}")
    print(f"products={', '.join(config.get('products', []))}")

    if not config.get("enabled"):
        print("Renderer is disabled; no data will be fetched.")
        return 0

    if args.dry_run:
        print("Dry run: would fetch recent public NOAA/Unidata Level III files.")
        return 0

    # TODO: Fetch recent Level III N0B files from public NOAA/Unidata sources.
    # Preferred first source: unidata-nexrad-level3 / official NOAA open data.
    # TODO: Store raw source files in an ignored cache directory.
    # TODO: Preserve NOAA attribution metadata in the generated catalog.
    print("TODO: implement NEXRAD Level III fetching.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
