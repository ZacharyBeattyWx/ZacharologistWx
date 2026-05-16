#!/usr/bin/env python3
"""
Build radar/frames.json from existing generated frame files.

This scaffold is safe to run before any frames exist. It creates a valid empty
catalog with the production contract keys. It does not activate the frontend
custom radar adapter.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_CONFIG = SCRIPT_DIR / "radar_config.json"
FRAME_RE = re.compile(r"^(?P<product>[A-Z0-9]{3})_(?P<date>\d{8})_(?P<time>\d{4})\.(?:webp|png)$", re.I)


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_valid_time(path: Path) -> str | None:
    match = FRAME_RE.match(path.name)
    if not match:
        return None

    stamp = f"{match.group('date')}{match.group('time')}"
    valid = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return valid.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def site_metadata(site: str) -> dict:
    sector = site[1:] if len(site) == 4 and site.startswith("K") else site
    return {
        "id": site,
        "sector": sector,
        "name": site,
        "network": "NEXRAD",
        "products": []
    }


def product_metadata(product: str, palette: str) -> dict:
    return {
        "id": product,
        "label": product,
        "units": "dBZ" if product in {"N0B", "N0Q"} else "",
        "palette": palette if product in {"N0B", "N0Q"} else ""
    }


def build_catalog(config: dict) -> dict:
    output_root = Path(config.get("outputRoot", "radar"))
    frame_dir = Path(config.get("frameOutputDir", "radar/frames"))
    catalog = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "sites": {},
        "products": {},
        "frames": {}
    }

    for site in config.get("sites", []):
        catalog["sites"][site] = site_metadata(site)
        catalog["frames"][site] = {}

        for product in config.get("products", []):
            catalog["products"].setdefault(
                product,
                product_metadata(product, config.get("palette", ""))
            )
            catalog["sites"][site]["products"].append(product)
            catalog["frames"][site][product] = []

    if not frame_dir.exists():
        return catalog

    for frame_path in sorted(frame_dir.glob("*/*/*")):
        if frame_path.suffix.lower() not in {".webp", ".png"}:
            continue

        try:
            site = frame_path.parts[-3]
            product = frame_path.parts[-2]
        except IndexError:
            continue

        valid_time = parse_valid_time(frame_path)
        if not valid_time:
            continue

        catalog["sites"].setdefault(site, site_metadata(site))
        catalog["products"].setdefault(
            product,
            product_metadata(product, config.get("palette", ""))
        )
        if product not in catalog["sites"][site]["products"]:
            catalog["sites"][site]["products"].append(product)

        catalog["frames"].setdefault(site, {}).setdefault(product, []).append({
            "slug": frame_path.stem,
            "url": "/" + frame_path.as_posix(),
            "validTime": valid_time,
            "bounds": [],
            "width": None,
            "height": None,
            "palette": config.get("palette", "")
        })

    return catalog


def main() -> int:
    parser = argparse.ArgumentParser(description="Build radar frames catalog.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = load_config(args.config)
    catalog = build_catalog(config)
    catalog_path = Path(config.get("catalogPath", "radar/frames.json"))

    if args.dry_run:
        print(json.dumps(catalog, indent=2))
        return 0

    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    with catalog_path.open("w", encoding="utf-8") as handle:
        json.dump(catalog, handle, indent=2)
        handle.write("\n")

    print(f"Wrote {catalog_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
