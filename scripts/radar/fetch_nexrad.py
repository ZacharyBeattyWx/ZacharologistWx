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
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "radar_config.json"
REPO_ROOT = SCRIPT_DIR.parents[1]
THREDDS_BASE = "https://thredds.ucar.edu/thredds"
CATALOG_NS = {"thredds": "http://www.unidata.ucar.edu/namespaces/thredds/InvCatalog/v1.0"}
LEVEL3_NAME_RE = re.compile(
    r"^Level3_(?P<sector>[A-Z0-9]{3})_(?P<product>[A-Z0-9]{3})_"
    r"(?P<date>\d{8})_(?P<time>\d{4})\.nids$"
)


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def site_to_sector(site: str) -> str:
    site = site.strip().upper()
    return site[1:] if len(site) == 4 and site.startswith("K") else site


def utc_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def catalog_url(product: str, sector: str, date: str) -> str:
    return f"{THREDDS_BASE}/catalog/nexrad/level3/IDD/{product}/{sector}/{date}/catalog.xml"


def file_url(url_path: str) -> str:
    return f"{THREDDS_BASE}/fileServer/{url_path}"


def find_latest_level3_file(product: str, sector: str, date: str) -> dict | None:
    url = catalog_url(product, sector, date)

    with urllib.request.urlopen(url, timeout=30) as response:
        xml_text = response.read()

    root = ET.fromstring(xml_text)
    matches = []

    for dataset in root.findall(".//thredds:dataset[@urlPath]", CATALOG_NS):
        name = dataset.attrib.get("name", "")
        url_path = dataset.attrib.get("urlPath", "")
        match = LEVEL3_NAME_RE.match(name)

        if not match:
            continue

        if match.group("sector") != sector or match.group("product") != product:
            continue

        matches.append({
            "name": name,
            "urlPath": url_path,
            "url": file_url(url_path),
            "date": match.group("date"),
            "time": match.group("time")
        })

    if not matches:
        return None

    return sorted(matches, key=lambda item: (item["date"], item["time"]))[-1]


def download_source_file(source: dict, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / source["name"]

    with urllib.request.urlopen(source["url"], timeout=60) as response:
        destination.write_bytes(response.read())

    return destination


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scaffold for fetching public NOAA/Unidata NEXRAD data."
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--date", default=utc_date(), help="UTC date in YYYYMMDD format.")
    parser.add_argument(
        "--source-cache",
        type=Path,
        default=REPO_ROOT / "radar" / "source" / "level3",
        help="Directory for raw public Level III source files.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Fetch even when radar_config.json has enabled=false.",
    )
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

    if not config.get("enabled") and not args.force:
        print("Renderer is disabled; no data will be fetched. Pass --force for a manual source fetch.")
        return 0

    site = config.get("sites", ["KFCX"])[0]
    product = config.get("products", ["N0B"])[0]
    sector = site_to_sector(site)

    source = find_latest_level3_file(product, sector, args.date)

    if not source:
        print(f"No public Level III source found for {sector}/{product}/{args.date}.")
        return 1

    print(f"latestSource={source['url']}")

    if args.dry_run:
        print(f"Dry run: would write {args.source_cache / source['name']}")
        return 0

    destination = download_source_file(source, args.source_cache)
    print(f"Wrote {destination}")

    # TODO: Support multiple sites/products and a configurable frame count.
    # TODO: Preserve NOAA attribution metadata in the generated catalog.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
