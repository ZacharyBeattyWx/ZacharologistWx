import argparse
import io
import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen


def verify_sector(base, platform, sector):
    prefix = f"{platform.lower()}/sectors/{sector['id']}/"
    url = f"{base}/{prefix}manifest.json"
    try:
        with urlopen(url, timeout=30) as response:
            manifest = json.load(response)
        assert manifest["nativeLocalized"] is True, "not a dedicated native render"
        assert manifest["projection"] == "EPSG:3857", "wrong projection"
        assert manifest["platform"] == platform and manifest["sector"] == sector["id"], "wrong sector"
        assert manifest["bbox"] == sector["bbox"], "wrong bbox"
        assert manifest["cadenceMinutes"] == 5 and manifest["dayNightComposite"], "wrong cadence/composite"
        assert manifest["frameCount"] == len(manifest["frames"]) > 0, "empty/inconsistent manifest"
        previous = None
        for frame in manifest["frames"]:
            stamp = datetime.fromisoformat(frame["time"].replace("Z", "+00:00"))
            assert previous is None or previous < stamp, "unordered timeline"
            previous = stamp
            assert frame["path"].startswith(prefix) and ".." not in frame["path"], "wrong frame path"
            assert 2048 <= frame["width"] <= 2560, "insufficient resolution"
            west, south, east, north = sector["bbox"]
            mercator = lambda latitude: math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2))
            ratio = math.radians(east - west) / (mercator(north) - mercator(south))
            assert abs(frame["width"] / frame["height"] - ratio) < 0.005, "wrong aspect ratio"
        age = (datetime.now(timezone.utc) - previous).total_seconds() / 60
        assert -10 <= age <= 45, f"stale imagery ({age:.0f} minutes)"
        frame = manifest["frames"][-1]
        with urlopen(f"{base}/{frame['path']}", timeout=30) as response:
            payload = response.read()
            assert response.headers.get("Content-Type", "").startswith("image/webp"), "wrong image content type"
        assert payload[:4] == b"RIFF" and payload[8:12] == b"WEBP", "not a WebP frame"
        from PIL import Image
        with Image.open(io.BytesIO(payload)) as image:
            assert image.size == (frame["width"], frame["height"]), "image/manifest dimension mismatch"
            image.load()
        return True, f"PASS {platform}/{sector['id']} {frame['width']}x{frame['height']} {len(manifest['frames'])} frames"
    except Exception as error:
        return False, f"UNAVAILABLE {platform}/{sector['id']}: {error}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="https://dt0cd6bl1yqh2.cloudfront.net/satellite-truecolor")
    parser.add_argument("--sector", help="Verify one sector ID across its supported platforms")
    args = parser.parse_args()
    catalog = json.loads(Path(__file__).with_name("localized-sectors.json").read_text())
    jobs = [(platform, sector) for platform, sectors in catalog.items() for sector in sectors
            if args.sector is None or sector["id"] == args.sector]
    if not jobs:
        parser.error("Unknown sector ID")
    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(lambda job: verify_sector(args.base.rstrip("/"), *job), jobs))
    for success, message in results:
        print(message)
    return 0 if all(success for success, message in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
