#!/usr/bin/env python3
"""Experimental fetcher for latest KFCX NEXRAD Level II archive file."""

from __future__ import annotations

import argparse
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "radar" / "source" / "level2" / "KFCX"
BUCKET_BASE = "https://unidata-nexrad-level2.s3.amazonaws.com"
XML_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
KEY_RE = re.compile(r"(?P<site>K[A-Z0-9]{3})(?P<ts>\d{8}_\d{6})")


def list_prefix(prefix: str) -> list[str]:
    url = f"{BUCKET_BASE}/?list-type=2&prefix={prefix}"
    with urllib.request.urlopen(url, timeout=30) as response:
        xml_bytes = response.read()

    root = ET.fromstring(xml_bytes)
    keys: list[str] = []
    for contents in root.findall("s3:Contents", XML_NS):
        key_el = contents.find("s3:Key", XML_NS)
        if key_el is not None and key_el.text:
            keys.append(key_el.text)
    return keys


def extract_valid_time_from_key(key: str) -> str | None:
    match = KEY_RE.search(Path(key).name)
    if not match:
        return None
    ts = match.group("ts")
    try:
        parsed = datetime.strptime(ts, "%Y%m%d_%H%M%S").replace(tzinfo=UTC)
        return parsed.isoformat()
    except ValueError:
        return None


def choose_latest_key(site: str, lookback_days: int) -> str | None:
    now = datetime.now(UTC)
    for day_offset in range(lookback_days + 1):
        dt = now - timedelta(days=day_offset)
        prefix = f"{dt:%Y/%m/%d}/{site}/"
        keys = list_prefix(prefix)

        candidates = []
        for key in keys:
            name = Path(key).name
            if "_MDM" in name:
                continue
            if not name.startswith(site):
                continue
            candidates.append(key)

        if candidates:
            return sorted(candidates)[-1]
    return None


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        destination.write_bytes(response.read())


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch latest KFCX Level II archive file (experimental).")
    parser.add_argument("--site", default="KFCX", help="Radar site, default KFCX")
    parser.add_argument("--lookback-days", type=int, default=2, help="How many UTC days to search")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Output directory for Level II source files",
    )
    args = parser.parse_args()

    site = args.site.strip().upper()
    key = choose_latest_key(site=site, lookback_days=max(0, args.lookback_days))
    if not key:
        print(f"No Level II file found for {site} in last {args.lookback_days} day(s).")
        return 1

    source_url = f"{BUCKET_BASE}/{key}"
    output_path = args.output_dir / Path(key).name
    download_file(source_url, output_path)

    valid_time = extract_valid_time_from_key(key)
    file_size = output_path.stat().st_size

    print(f"sourceURL={source_url}")
    print(f"outputPath={output_path}")
    print(f"validTime={valid_time or 'unknown'}")
    print(f"fileSizeBytes={file_size}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
