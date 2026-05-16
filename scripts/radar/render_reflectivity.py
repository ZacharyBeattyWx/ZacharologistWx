#!/usr/bin/env python3
"""
Future Level III reflectivity renderer scaffold.

This script can inspect a local public NOAA/Unidata Level III NIDS file with
MetPy, but it intentionally refuses to fake radar imagery. Current website
radar still uses Windy/IEM, and custom frames remain inactive until the backend
is real and `USE_CUSTOM_RADAR_FRAMES` is explicitly enabled.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "radar_config.json"
REPO_ROOT = SCRIPT_DIR.parents[1]
SOURCE_RE = re.compile(
    r"^Level3_(?P<sector>[A-Z0-9]{3})_(?P<product>[A-Z0-9]{3})_"
    r"(?P<date>\d{8})_(?P<time>\d{4})\.nids$"
)
DEFAULT_REFLECTIVITY_COLOR_TABLE = {
    "units": "dBZ",
    "step": 10,
    "product": "BR",
    "colors": [
        {"value": -10, "stops": [{"rgb": [7, 59, 71], "alpha": 0}]},
        {"value": 0, "stops": [{"rgb": [62, 69, 71]}, {"rgb": [191, 193, 197]}]},
        {"value": 20, "stops": [{"rgb": [135, 229, 125]}]},
        {"value": 30, "stops": [{"rgb": [48, 102, 43]}]},
        {"value": 35, "stops": [{"rgb": [253, 227, 0]}]},
        {"value": 50, "stops": [{"rgb": [254, 26, 0]}, {"rgb": [181, 0, 52]}]},
        {"value": 60, "stops": [{"rgb": [163, 0, 136]}, {"rgb": [254, 4, 250]}]},
        {"value": 70, "stops": [{"rgb": [67, 190, 254]}, {"rgb": [19, 144, 242]}]},
        {"value": 80, "stops": [{"rgb": [166, 176, 150]}, {"rgb": [255, 231, 188]}]},
        {"value": 85, "stops": [{"rgb": [255, 231, 188]}]},
    ],
}
DEFAULT_MIN_VISIBLE_DBZ = 15.0
DEFAULT_MIN_COMPONENT_PIXELS = 6


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def source_metadata(path: Path) -> dict:
    match = SOURCE_RE.match(path.name)
    if not match:
        return {}

    return match.groupdict()


def valid_time_from_metadata(meta: dict) -> str:
    stamp = f"{meta['date']}{meta['time']}"
    valid = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return valid.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def calculate_rough_bounds(lat: float, lon: float, range_km: float) -> list[list[float]]:
    # Rough first-pass bounds. Replace with proper geodetic radar projection later.
    lat_delta = range_km / 111.32
    lon_delta = range_km / (111.32 * math.cos(math.radians(lat)))

    return [
        [lat - lat_delta, lon - lon_delta],
        [lat + lat_delta, lon + lon_delta],
    ]


def first_stop_rgba(color_entry: dict) -> tuple[int, int, int, int]:
    stop = color_entry["stops"][0]
    red, green, blue = stop["rgb"]
    alpha = stop.get("alpha", 255)
    return int(red), int(green), int(blue), int(alpha)


def rgba_for_dbz(value: float) -> tuple[int, int, int, int]:
    color_entries = DEFAULT_REFLECTIVITY_COLOR_TABLE["colors"]

    if value < color_entries[0]["value"]:
        return first_stop_rgba(color_entries[0])

    selected = color_entries[-1]

    for entry in color_entries:
        if value >= entry["value"]:
            selected = entry
        else:
            break

    return first_stop_rgba(selected)


def remove_small_components(visible_mask, min_component_pixels: int = DEFAULT_MIN_COMPONENT_PIXELS):
    import numpy as np

    mask = np.asarray(visible_mask, dtype=bool)

    if min_component_pixels <= 1:
        return mask.copy()

    height, width = mask.shape
    cleaned = np.zeros_like(mask, dtype=bool)
    visited = np.zeros_like(mask, dtype=bool)

    for start_y, start_x in zip(*np.nonzero(mask)):
        if visited[start_y, start_x]:
            continue

        component = []
        stack = [(int(start_y), int(start_x))]
        visited[start_y, start_x] = True

        while stack:
            y, x = stack.pop()
            component.append((y, x))

            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue

                    ny = y + dy
                    nx = x + dx

                    if ny < 0 or ny >= height or nx < 0 or nx >= width:
                        continue

                    if visited[ny, nx] or not mask[ny, nx]:
                        continue

                    visited[ny, nx] = True
                    stack.append((ny, nx))

        if len(component) >= min_component_pixels:
            for y, x in component:
                cleaned[y, x] = True

    return cleaned


def reflectivity_to_rgba(
    values,
    min_visible_dbz: float = DEFAULT_MIN_VISIBLE_DBZ,
    min_component_pixels: int = DEFAULT_MIN_COMPONENT_PIXELS,
):
    import numpy as np

    numeric = np.asarray(np.ma.array(values).filled(np.nan), dtype=float)
    height, width = numeric.shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    finite_mask = np.isfinite(numeric)
    raw_visible_mask = finite_mask & (numeric >= min_visible_dbz)
    visible_mask = remove_small_components(raw_visible_mask, min_component_pixels)

    for entry in DEFAULT_REFLECTIVITY_COLOR_TABLE["colors"]:
        threshold = entry["value"]
        color = first_stop_rgba(entry)
        rgba[visible_mask & (numeric >= threshold)] = color

    rgba[visible_mask & (numeric < 5), 3] = 90
    rgba[visible_mask & (numeric >= 5) & (numeric < 10), 3] = 150
    rgba[~finite_mask] = [0, 0, 0, 0]
    rgba[finite_mask & ~visible_mask] = [0, 0, 0, 0]
    return rgba


def reflectivity_stats(
    values,
    min_visible_dbz: float = DEFAULT_MIN_VISIBLE_DBZ,
    min_component_pixels: int = DEFAULT_MIN_COMPONENT_PIXELS,
) -> dict:
    import numpy as np

    numeric = np.asarray(np.ma.array(values).filled(np.nan), dtype=float)
    finite_mask = np.isfinite(numeric)
    finite_values = numeric[np.isfinite(numeric)]
    total_pixels = int(numeric.size)
    finite_pixels = int(finite_values.size)
    raw_visible_mask = finite_mask & (numeric >= min_visible_dbz)
    visible_mask = remove_small_components(raw_visible_mask, min_component_pixels)
    raw_visible_pixels = int(raw_visible_mask.sum())
    visible_pixels = int(visible_mask.sum())
    removed_speckle_pixels = raw_visible_pixels - visible_pixels
    visible_coverage = (visible_pixels / total_pixels * 100) if total_pixels else 0.0

    return {
        "minVisibleDbz": float(min_visible_dbz),
        "minComponentPixels": int(min_component_pixels),
        "totalPixels": total_pixels,
        "finitePixels": finite_pixels,
        "rawVisiblePixels": raw_visible_pixels,
        "visiblePixels": visible_pixels,
        "removedSpecklePixels": removed_speckle_pixels,
        "visibleCoveragePercent": visible_coverage,
        "finiteMin": float(np.nanmin(finite_values)) if finite_pixels else None,
        "finiteMax": float(np.nanmax(finite_values)) if finite_pixels else None,
        "finiteMean": float(np.nanmean(finite_values)) if finite_pixels else None,
    }


def catalog_product_metadata(product: str) -> dict:
    return {
        "id": product,
        "label": "Super-Res Base Reflectivity" if product == "N0B" else product,
        "units": "dBZ",
        "palette": "DEFAULT_REFLECTIVITY_COLOR_TABLE",
    }


def update_frames_catalog(catalog_path: Path, frame_entry: dict, site: str, sector: str, product: str) -> None:
    catalog_path.parent.mkdir(parents=True, exist_ok=True)

    if catalog_path.exists():
        with catalog_path.open("r", encoding="utf-8") as handle:
            catalog = json.load(handle)
    else:
        catalog = {
            "schemaVersion": 1,
            "generatedAt": "",
            "sites": {},
            "products": {},
            "frames": {},
        }

    catalog["schemaVersion"] = catalog.get("schemaVersion", 1)
    catalog["generatedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    catalog.setdefault("sites", {})
    catalog.setdefault("products", {})
    catalog.setdefault("frames", {})

    catalog["sites"][site] = {
        "id": site,
        "sector": sector,
        "name": site,
        "network": "NEXRAD",
        "products": [product],
    }
    catalog["products"][product] = catalog_product_metadata(product)
    catalog["frames"].setdefault(site, {})
    catalog["frames"][site][product] = [frame_entry]

    with catalog_path.open("w", encoding="utf-8") as handle:
        json.dump(catalog, handle, indent=2)
        handle.write("\n")


def summarize_numeric_array(name: str, values) -> None:
    import numpy as np

    array = np.ma.array(values)
    filled = np.asarray(array.filled(np.nan), dtype=float)
    finite_values = filled[np.isfinite(filled)]
    unique_sample = np.unique(finite_values)[:20] if finite_values.size else []
    total_count = int(filled.size)
    finite_count = int(finite_values.size)
    nan_count = int(np.isnan(filled).sum())
    masked_count = int(np.ma.count_masked(array))
    finite_coverage = (finite_count / total_count * 100) if total_count else 0.0

    print(f"array={name}")
    print(f"  shape={array.shape}")
    print(f"  dtype={array.dtype}")
    print(f"  total_count={total_count}")
    print(f"  finite_count={finite_count}")
    print(f"  nan_count={nan_count}")
    print(f"  masked_count={masked_count}")
    print(f"  finite_coverage_percent={finite_coverage:.6f}")

    if finite_values.size:
        print(f"  finite_min={float(np.nanmin(finite_values))}")
        print(f"  finite_max={float(np.nanmax(finite_values))}")
        print(f"  finite_mean={float(np.nanmean(finite_values))}")
        print(f"  unique_finite_sample={[float(value) for value in unique_sample]}")
    else:
        print("  unique_finite_sample=[]")
        if "mapped_data" in name:
            print("  Decoded successfully, but no finite reflectivity values were found in mapped_data.")


def summarize_item_value(name: str, value) -> None:
    import numpy as np

    print(f"  {name}_type={type(value).__name__}")

    if isinstance(value, (str, bytes, int, float, bool)) or value is None:
        print(f"  {name}_value={value!r}")
        return

    try:
        length = len(value)
        print(f"  {name}_length={length}")
    except TypeError:
        length = None

    if hasattr(value, "shape"):
        print(f"  {name}_shape={value.shape}")
        print(f"  {name}_dtype={getattr(value, 'dtype', '')}")

    if isinstance(value, dict):
        print(f"  {name}_keys={list(value.keys())[:20]}")
        return

    if isinstance(value, (list, tuple)):
        print(f"  {name}_sample={repr(value[:3])[:500]}")
        return

    try:
        array = np.asarray(value)
        print(f"  {name}_array_shape={array.shape}")
        print(f"  {name}_array_dtype={array.dtype}")
        print(f"  {name}_array_sample={repr(array.ravel()[:10].tolist())[:500]}")
    except Exception as error:
        print(f"  {name}_summary_error={error}")


def inspect_level3_file(path: Path) -> bool:
    level3, mapped = decode_level3_mapped_data(path)

    if level3 is None:
        return False

    meta = source_metadata(path)
    print("Decoded Level III NIDS file with MetPy.")
    print(f"sourceFile={path}")
    if meta:
        print(f"sector={meta.get('sector')}")
        print(f"product={meta.get('product')}")
        print(f"stamp={meta.get('date')}_{meta.get('time')}")

    print_level3_metadata(level3)
    print_level3_sym_block_summary(level3)

    if mapped is not None:
        print("Decode succeeded, but final WebP rendering is intentionally blocked unless --render is provided.")
        return True

    print("No mappable data arrays were found; no frame was generated.")
    return False


def decode_level3_mapped_data(path: Path):
    try:
        from metpy.io import Level3File
    except ImportError as error:
        print("MetPy is not installed; cannot decode Level III NIDS data.")
        print("Install renderer dependencies with: pip install -r scripts/radar/requirements.txt")
        print(f"Import error: {error}")
        return None, None

    try:
        level3 = Level3File(str(path))
    except Exception as error:
        print(f"MetPy failed to open {path}: {error}")
        return None, None

    mapped = None

    sym_block = getattr(level3, "sym_block", []) or []

    if sym_block and sym_block[0] and isinstance(sym_block[0][0], dict):
        item = sym_block[0][0]

        if "data" in item:
            try:
                mapped = level3.map_data(item["data"])
            except Exception as error:
                print(f"MetPy decoded the file, but map_data failed: {error}")

    return level3, mapped


def print_level3_metadata(level3) -> None:
    for attr in (
        "prod_desc",
        "prod_id",
        "prod_name",
        "max_range",
        "lat",
        "lon",
        "height"
    ):
        if hasattr(level3, attr):
            print(f"{attr}={getattr(level3, attr)}")


def print_level3_sym_block_summary(level3) -> None:
    sym_block = getattr(level3, "sym_block", []) or []
    print(f"sym_block_count={len(sym_block)}")

    decoded_any = False

    for block_index, block in enumerate(sym_block):
        print(f"sym_block[{block_index}] item_count={len(block)}")

        for item_index, item in enumerate(block):
            if not isinstance(item, dict):
                print(f"  item[{item_index}] type={type(item).__name__}")
                continue

            print(f"  item[{item_index}] keys={sorted(item.keys())}")

            for key in ("center", "first", "gate_scale", "data"):
                if key in item:
                    summarize_item_value(f"item[{item_index}].{key}", item[key])

            if "data" not in item:
                continue

            try:
                mapped = level3.map_data(item["data"])
                summarize_numeric_array(f"sym_block[{block_index}][{item_index}].mapped_data", mapped)
                print("  mapped_data_interpretation=MetPy map_data output; finite values are required before treating this as dBZ reflectivity.")
                decoded_any = True
            except Exception as error:
                print(f"  unable to map data values: {error}")

            for key in ("start_az", "end_az"):
                if key in item:
                    summarize_numeric_array(f"sym_block[{block_index}][{item_index}].{key}", item[key])

    if decoded_any:
        print("Decode succeeded, but final WebP rendering is intentionally blocked for now.")
        print("Blocker: need explicit polar-to-image projection/geographic bounds before creating a real frame.")
    else:
        print("No mappable data arrays were found; no frame was generated.")

    return decoded_any


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
        "--force",
        action="store_true",
        help="Inspect local source files even when radar_config.json has enabled=false.",
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Decode and print Level III metadata/arrays, then stop before image generation.",
    )
    parser.add_argument(
        "--render",
        action="store_true",
        help="Render one real transparent WebP from finite mapped_data values.",
    )
    parser.add_argument(
        "--min-visible-dbz",
        type=float,
        default=DEFAULT_MIN_VISIBLE_DBZ,
        help="Minimum reflectivity value to render as visible pixels.",
    )
    parser.add_argument(
        "--min-component-pixels",
        type=int,
        default=DEFAULT_MIN_COMPONENT_PIXELS,
        help="Minimum connected visible pixel component size to keep.",
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

    if not config.get("enabled") and not (args.force or args.diagnose or args.render):
        print("Renderer is disabled; no frames will be rendered. Pass --diagnose for a manual decode inspection.")
        return 0

    if args.dry_run:
        print("Dry run: would decode Level III N0B and render transparent frames.")
        return 0

    source_files = sorted(args.source_cache.glob("Level3_*_N0B_*.nids"))

    if not source_files:
        print(f"No Level III N0B source files found in {args.source_cache}.")
        return 1

    source_file = source_files[-1]
    print(f"Found source file: {source_file}")

    decoded = inspect_level3_file(source_file)

    if not decoded:
        print("No WebP/PNG frame was created.")
        return 2

    if args.diagnose:
        print("Diagnostic mode complete. Stopping before image generation.")
        print("No WebP/PNG frame was created.")
        return 0

    if args.render:
        level3, mapped = decode_level3_mapped_data(source_file)

        if level3 is None or mapped is None:
            print("No WebP/PNG frame was created.")
            return 2

        meta = source_metadata(source_file)
        site = f"K{meta['sector']}"
        product = meta["product"]
        slug = f"{product}_{meta['date']}_{meta['time']}"
        frame_dir = REPO_ROOT / "radar" / "frames" / site / product
        frame_dir.mkdir(parents=True, exist_ok=True)
        frame_path = frame_dir / f"{slug}.webp"

        from PIL import Image

        stats = reflectivity_stats(mapped, args.min_visible_dbz, args.min_component_pixels)
        rgba = reflectivity_to_rgba(mapped, args.min_visible_dbz, args.min_component_pixels)
        image = Image.fromarray(rgba, mode="RGBA")
        image.save(frame_path, "WEBP", lossless=True)

        lat = float(getattr(level3, "lat"))
        lon = float(getattr(level3, "lon"))
        range_km = float(getattr(level3, "max_range"))
        mapped_shape = [int(dimension) for dimension in mapped.shape]
        bounds = calculate_rough_bounds(lat, lon, range_km)
        relative_url = "/" + frame_path.relative_to(REPO_ROOT).as_posix()
        frame_entry = {
            "slug": slug,
            "url": relative_url,
            "validTime": valid_time_from_metadata(meta),
            "bounds": bounds,
            "width": image.width,
            "height": image.height,
            "palette": "DEFAULT_REFLECTIVITY_COLOR_TABLE",
            "stats": stats,
            "debug": {
                "radarLat": lat,
                "radarLon": lon,
                "maxRangeKm": range_km,
                "mappedShape": mapped_shape,
                "imageWidth": image.width,
                "imageHeight": image.height,
                "calculatedBounds": bounds,
                "projectionMode": "rough-bounds-v1",
            },
        }

        update_frames_catalog(
            REPO_ROOT / config.get("catalogPath", "radar/frames.json"),
            frame_entry,
            site,
            meta["sector"],
            product,
        )

        print(f"Wrote {frame_path}")
        print(f"Updated {config.get('catalogPath', 'radar/frames.json')}")
        print(f"radarLat={lat}")
        print(f"radarLon={lon}")
        print(f"maxRangeKm={range_km}")
        print(f"mappedShape={mapped_shape}")
        print(f"imageWidth={image.width}")
        print(f"imageHeight={image.height}")
        print(f"bounds={bounds}")
        print(f"minVisibleDbz={stats['minVisibleDbz']}")
        print(f"minComponentPixels={stats['minComponentPixels']}")
        print(f"rawVisiblePixels={stats['rawVisiblePixels']}")
        print(f"visiblePixelsAfterDespeckle={stats['visiblePixels']}")
        print(f"removedSpecklePixels={stats['removedSpecklePixels']}")
        print(f"visibleCoveragePercent={stats['visibleCoveragePercent']:.6f}")
        return 0

    # TODO: Apply DEFAULT_REFLECTIVITY_COLOR_TABLE from the frontend contract.
    # TODO: Render transparent WebP or PNG frames.
    # TODO: Calculate geographic bounds for each output image.
    # TODO: Write frames to radar/frames/{site}/{product}/{slug}.webp.
    print("No WebP/PNG frame was created.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
