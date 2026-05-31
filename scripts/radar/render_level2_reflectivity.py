#!/usr/bin/env python3
"""Experimental projected Level II reflectivity (dBZ) GeoTIFF renderer for regional radar sites."""

from __future__ import annotations

import argparse
import json
import math
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
from metpy.io import Level2File

try:
    from PIL import Image
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Pillow is required for mobile WebP output. Install with: pip install pillow"
    ) from exc


try:
    import rasterio
    from rasterio.transform import from_bounds
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "rasterio is required for GeoTIFF output. Install with: pip install rasterio"
    ) from exc

try:
    from pyproj import CRS, Transformer
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "pyproj is required for projected sampling. Install with: pip install pyproj"
    ) from exc

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
LEVEL2_SOURCE_BASE = REPO_ROOT / "radar" / "source" / "level2"
LEVEL2_OUTPUT_BASE = REPO_ROOT / "radar" / "tilesets" / "test"
FRAMES_JSON = REPO_ROOT / "radar" / "frames.json"
DEFAULT_SITE = "KFCX"
LEVEL2_PRODUCT = "LEVEL2_REF0"
NODATA = -9999.0
OUTPUT_SIZE = 5120
MAX_LEVEL2_FRAMES = 25
MOBILE_WEBP_DIR = "mobile"
MOBILE_WEBP_MAX_SIZE = 2048
MOBILE_WEBP_QUALITY = 84
DISPLAY_MIN_DBZ = -32.0

RADAR_DBZ_PALETTE = [
    (-32, 88, 54, 128, 8),
    (-30, 96, 62, 138, 10),
    (-28, 105, 72, 145, 12),
    (-26, 116, 85, 150, 15),
    (-24, 128, 99, 153, 18),
    (-22, 139, 113, 153, 22),
    (-20, 148, 128, 150, 28),
    (-18, 155, 140, 145, 34),
    (-16, 160, 150, 138, 42),
    (-14, 163, 157, 130, 52),
    (-12, 160, 158, 123, 62),
    (-10, 156, 155, 119, 72),
    (-8, 167, 167, 136, 80),
    (-6, 175, 176, 150, 88),
    (-4, 158, 163, 150, 98),
    (-2, 135, 144, 145, 108),
    (0, 115, 128, 142, 120),
    (2, 92, 109, 137, 132),
    (4, 73, 93, 133, 144),
    (6, 55, 81, 132, 156),
    (8, 63, 97, 141, 168),
    (10, 73, 117, 152, 180),
    (15, 76, 165, 142, 205),
    (20, 18, 118, 24, 230),
    (25, 203, 222, 1, 245),
    (30, 215, 203, 0, 255),
    (35, 227, 129, 3, 255),
    (40, 185, 95, 10, 255),
    (45, 192, 37, 20, 255),
    (50, 202, 153, 180, 255),
    (55, 196, 74, 138, 255),
    (60, 139, 32, 210, 255),
    (65, 86, 20, 162, 255),
    (70, 111, 210, 219, 255),
    (75, 74, 132, 154, 255),
    (80, 115, 10, 1, 255),
    (85, 235, 190, 255, 255),
    (90, 255, 230, 245, 255),
    (95, 255, 255, 255, 255),
]

LOW_DBZ_OPACITY_TAPER = [
    (-32, 0.0),
    (-20, 0.01),
    (-10, 0.04),
    (0, 0.12),
    (5, 0.32),
    (10, 0.7),
    (15, 1.0),
]
KEY_RE = re.compile(r"(?P<site>K[A-Z0-9]{3})(?P<ts>\d{8}_\d{6})")
PROJECTED_NAME_RE = re.compile(
    r"^(?P<site>[A-Z0-9]{4})_(?P<date>\d{8})_(?P<time>\d{6})_projected_dbz\.tif$"
)
RAW_VOLUME_NAME_RE = re.compile(r"^(?P<site>K[A-Z0-9]{3})(?P<ts>\d{8}_\d{6})_V\d{2}(?:\.gz)?$")
S3_XML_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
DEFAULT_SOURCE_BUCKET = "unidata-nexrad-level2"

SITE_COORDS = {
    "KFCX": (-80.273, 37.024),
    "KRAX": (-78.490, 35.665),
    "KGSP": (-82.220, 34.883),
    "KCAE": (-81.118, 33.949),
    "KCLX": (-81.042, 32.656),
    "KLTX": (-78.429, 33.989),
    "KMHX": (-76.877, 34.776),
    "KAKQ": (-77.007, 36.983),
}

SITE_LON_HALF_DEG = 5.176
SITE_LAT_HALF_DEG = 4.132


def fallback_bounds_for_site(site: str) -> tuple[float, float, float, float]:
    """Return a broad Level II display box as west/south/east/north."""
    center = SITE_COORDS.get(str(site or "").upper())
    if center is None:
        return (-86.6, 32.2, -73.4, 42.2)
    lon, lat = center
    return (
        lon - SITE_LON_HALF_DEG,
        lat - SITE_LAT_HALF_DEG,
        lon + SITE_LON_HALF_DEG,
        lat + SITE_LAT_HALF_DEG,
    )



@dataclass
class SweepData:
    reflectivity: np.ndarray
    azimuth_deg: np.ndarray
    first_gate_km: float
    gate_width_km: float
    elevation_deg: float
    site_lat: float
    site_lon: float


def infer_valid_time_from_name(path: Path) -> str | None:
    match = KEY_RE.search(path.name)
    if not match:
        return None
    try:
        dt = datetime.strptime(match.group("ts"), "%Y%m%d_%H%M%S").replace(tzinfo=UTC)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def format_utc_iso(value: datetime | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return ""
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return format_utc_iso(parsed)
        except ValueError:
            return value
    dt = value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    else:
        dt = dt.astimezone(UTC)
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def valid_time_from_projected_filename(path: Path) -> str:
    match = PROJECTED_NAME_RE.match(path.name)
    if not match:
        return ""
    try:
        dt = datetime.strptime(
            f"{match.group('date')}{match.group('time')}",
            "%Y%m%d%H%M%S",
        )
    except ValueError:
        return ""
    return format_utc_iso(dt)


def prune_level2_output_frames(output_root: Path, keep: int) -> None:
    frame_files = sorted(
        output_root.glob("*_projected_dbz.tif"),
        key=lambda file_path: file_path.stat().st_mtime,
        reverse=True,
    )
    for stale_file in frame_files[keep:]:
        stale_file.unlink(missing_ok=True)


def prune_level2_source_files(source_root: Path, keep: int) -> None:
    source_files = sorted(
        [path for path in source_root.iterdir() if path.is_file() and RAW_VOLUME_NAME_RE.match(path.name)],
        key=lambda file_path: file_path.stat().st_mtime,
        reverse=True,
    )
    for stale_file in source_files[keep:]:
        stale_file.unlink(missing_ok=True)


def parse_source_date(value: str) -> datetime:
    value = value.strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    raise ValueError(f"Invalid --source-date '{value}'. Expected YYYY/MM/DD or YYYY-MM-DD.")


def list_s3_prefix_keys(bucket: str, prefix: str) -> list[str]:
    encoded_prefix = urllib.parse.quote(prefix, safe="/")
    continuation_token = ""
    keys: list[str] = []
    while True:
        token_part = f"&continuation-token={urllib.parse.quote(continuation_token)}" if continuation_token else ""
        url = (
            f"https://{bucket}.s3.amazonaws.com/"
            f"?list-type=2&prefix={encoded_prefix}{token_part}"
        )
        with urllib.request.urlopen(url, timeout=60) as response:
            xml_payload = response.read()
        root = ET.fromstring(xml_payload)
        for contents in root.findall("s3:Contents", S3_XML_NS):
            key_element = contents.find("s3:Key", S3_XML_NS)
            if key_element is not None and key_element.text:
                keys.append(key_element.text)
        next_token_element = root.find("s3:NextContinuationToken", S3_XML_NS)
        continuation_token = next_token_element.text if next_token_element is not None and next_token_element.text else ""
        if not continuation_token:
            break
    return keys


def key_sort_ts(name: str) -> str:
    match = RAW_VOLUME_NAME_RE.match(name)
    return match.group("ts") if match else ""


def fetch_latest_source_scans(
    source_dir: Path,
    site: str,
    bucket: str,
    source_count: int,
    source_date: str | None,
    force: bool,
) -> None:
    source_dir.mkdir(parents=True, exist_ok=True)
    anchor_day = parse_source_date(source_date) if source_date else datetime.now(UTC)

    print(f"fetchBucket={bucket}")
    print(f"fetchSite={site}")
    print(f"fetchTargetCount={source_count}")
    if source_date:
        print(f"fetchAnchorDate={anchor_day.strftime('%Y-%m-%d')}")

    candidate_keys: list[str] = []
    scanned_days = 0
    while len(candidate_keys) < source_count and scanned_days < 7:
        day = anchor_day - timedelta(days=scanned_days)
        prefix = f"{day:%Y/%m/%d}/{site}/"
        day_keys = list_s3_prefix_keys(bucket=bucket, prefix=prefix)
        valid_day_keys = []
        for key in day_keys:
            filename = Path(key).name
            if filename.endswith(".md5") or "_MDM" in filename:
                continue
            if RAW_VOLUME_NAME_RE.match(filename):
                valid_day_keys.append(key)
        if valid_day_keys:
            valid_day_keys.sort(key=lambda k: key_sort_ts(Path(k).name))
            candidate_keys.extend(valid_day_keys)
        scanned_days += 1

    if not candidate_keys:
        print("fetchFound=0")
        return

    # Keep only newest N across all scanned days.
    candidate_keys.sort(key=lambda k: key_sort_ts(Path(k).name))
    selected_keys = candidate_keys[-source_count:]
    print(f"fetchFound={len(selected_keys)}")

    downloaded = 0
    skipped = 0
    for key in selected_keys:
        filename = Path(key).name
        output_path = source_dir / filename
        if output_path.exists() and not force:
            skipped += 1
            print(f"sourceSkipExisting={output_path.name}")
            continue
        file_url = f"https://{bucket}.s3.amazonaws.com/{urllib.parse.quote(key)}"
        with urllib.request.urlopen(file_url, timeout=120) as response:
            output_path.write_bytes(response.read())
        downloaded += 1
        print(f"sourceDownloaded={output_path.name}")

    prune_level2_source_files(source_dir, keep=source_count)
    print(f"sourceDownloadedCount={downloaded}")
    print(f"sourceSkippedCount={skipped}")


def build_level2_frames_manifest(
    output_root: Path,
    site: str,
    product: str,
    bounds: tuple[float, float, float, float],
    latest_frame_name: str | None = None,
    latest_valid_time: str | None = None,
) -> dict:
    west, south, east, north = bounds
    frame_files = sorted(
        output_root.glob("*_projected_dbz.tif"),
        key=lambda file_path: file_path.stat().st_mtime,
    )
    frames = []
    for frame_file in frame_files:
        valid_time = ""
        if latest_frame_name and latest_valid_time and frame_file.name == latest_frame_name:
            valid_time = format_utc_iso(latest_valid_time)
        if not valid_time:
            valid_time = valid_time_from_projected_filename(frame_file)
        if not valid_time:
            valid_time = infer_valid_time_from_name(frame_file) or ""
        frames.append(
            {
                "path": f"/radar/tilesets/test/{site}/LEVEL2/REF0/{frame_file.name}",
                "imagePath": f"/radar/tilesets/test/{site}/LEVEL2/REF0/{MOBILE_WEBP_DIR}/{frame_file.stem}.webp",
                "validTime": valid_time,
                "bounds": {
                    "west": west,
                    "south": south,
                    "east": east,
                    "north": north,
                },
            }
        )
    return {
        "site": site,
        "product": product,
        "updatedAt": datetime.now(tz=UTC).isoformat(),
        "frames": frames,
    }


def latest_level2_file(input_root: Path) -> Path:
    if not input_root.exists():
        raise FileNotFoundError(f"Level II input directory missing: {input_root}")
    files = sorted(p for p in input_root.iterdir() if p.is_file())
    if not files:
        raise FileNotFoundError(f"No Level II files in: {input_root}")
    return files[-1]


def recent_level2_files(input_root: Path, max_count: int) -> list[Path]:
    if not input_root.exists():
        raise FileNotFoundError(f"Level II input directory missing: {input_root}")
    files = sorted(p for p in input_root.iterdir() if p.is_file())
    if not files:
        raise FileNotFoundError(f"No Level II files in: {input_root}")
    return files[-max_count:]


def load_bounds_from_frames_json(site: str = DEFAULT_SITE) -> tuple[float, float, float, float]:
    fallback = fallback_bounds_for_site(site)
    if not FRAMES_JSON.exists():
        return fallback

    data = json.loads(FRAMES_JSON.read_text(encoding="utf-8"))
    frames = data.get("frames", {}).get(site, {}).get("N0B", [])
    if not isinstance(frames, list) or not frames:
        return fallback

    bounds = frames[0].get("bounds")
    if (
        isinstance(bounds, list)
        and len(bounds) == 2
        and isinstance(bounds[0], list)
        and isinstance(bounds[1], list)
        and len(bounds[0]) == 2
        and len(bounds[1]) == 2
    ):
        south, west = float(bounds[0][0]), float(bounds[0][1])
        north, east = float(bounds[1][0]), float(bounds[1][1])
        return west, south, east, north

    return fallback


def extract_lowest_reflectivity_sweep(level2: Level2File) -> SweepData:
    best: SweepData | None = None

    for sweep in level2.sweeps:
        if not sweep:
            continue

        rays_with_ref = [ray for ray in sweep if isinstance(ray, tuple) and len(ray) >= 5 and b"REF" in ray[4]]
        if not rays_with_ref:
            continue

        first_ray = rays_with_ref[0]
        ref_hdr = first_ray[4][b"REF"][0]
        num_gates = int(ref_hdr.num_gates)
        ref_rows = []
        azimuths = []

        for ray in rays_with_ref:
            azimuths.append(float(ray[0].az_angle))
            row = np.asarray(ray[4][b"REF"][1], dtype=np.float32)
            if row.shape[0] < num_gates:
                padded = np.full((num_gates,), np.nan, dtype=np.float32)
                padded[: row.shape[0]] = row
                row = padded
            elif row.shape[0] > num_gates:
                row = row[:num_gates]
            ref_rows.append(row)

        ref = np.stack(ref_rows, axis=0)
        az = np.asarray(azimuths, dtype=np.float32)
        elevation = float(first_ray[0].el_angle)
        site_lat = float(first_ray[1].lat)
        site_lon = float(first_ray[1].lon)

        current = SweepData(
            reflectivity=ref,
            azimuth_deg=az,
            first_gate_km=float(ref_hdr.first_gate),
            gate_width_km=float(ref_hdr.gate_width),
            elevation_deg=elevation,
            site_lat=site_lat,
            site_lon=site_lon,
        )

        if best is None or current.elevation_deg < best.elevation_deg:
            best = current

    if best is None:
        raise RuntimeError("No reflectivity moments (REF) found in Level II file")

    return best


def circular_nearest_indices(angles_deg: np.ndarray, targets_deg: np.ndarray) -> np.ndarray:
    order = np.argsort(angles_deg)
    sorted_angles = angles_deg[order]
    pos = np.searchsorted(sorted_angles, targets_deg, side="left")

    left_pos = (pos - 1) % sorted_angles.size
    right_pos = pos % sorted_angles.size

    left_angles = sorted_angles[left_pos]
    right_angles = sorted_angles[right_pos]

    left_dist = np.abs(((targets_deg - left_angles + 180.0) % 360.0) - 180.0)
    right_dist = np.abs(((targets_deg - right_angles + 180.0) % 360.0) - 180.0)

    choose_right = right_dist < left_dist
    chosen_pos = np.where(choose_right, right_pos, left_pos)
    return order[chosen_pos]


def build_projected_dbz_grid(
    sweep: SweepData,
    bounds: tuple[float, float, float, float],
    output_size: int,
    nodata: float,
    row_chunk: int = 128,
) -> np.ndarray:
    west, south, east, north = bounds
    out = np.full((output_size, output_size), nodata, dtype=np.float32)

    lon_step = (east - west) / output_size
    lat_step = (north - south) / output_size

    lons = west + (np.arange(output_size, dtype=np.float64) + 0.5) * lon_step

    aeqd = CRS.from_proj4(
        f"+proj=aeqd +lat_0={sweep.site_lat} +lon_0={sweep.site_lon} +datum=WGS84 +units=m +no_defs"
    )
    tx = Transformer.from_crs("EPSG:4326", aeqd, always_xy=True)

    num_gates = sweep.reflectivity.shape[1]
    max_range_km = sweep.first_gate_km + sweep.gate_width_km * (num_gates - 1)

    for y0 in range(0, output_size, row_chunk):
        y1 = min(output_size, y0 + row_chunk)
        lat_rows = north - (np.arange(y0, y1, dtype=np.float64) + 0.5) * lat_step

        lon_grid, lat_grid = np.meshgrid(lons, lat_rows)
        flat_lon = lon_grid.ravel()
        flat_lat = lat_grid.ravel()

        x_m, y_m = tx.transform(flat_lon, flat_lat)
        x_m = np.asarray(x_m, dtype=np.float64)
        y_m = np.asarray(y_m, dtype=np.float64)

        range_km = np.hypot(x_m, y_m) / 1000.0
        azimuth = (np.degrees(np.arctan2(x_m, y_m)) + 360.0) % 360.0

        gate_idx = np.rint((range_km - sweep.first_gate_km) / sweep.gate_width_km).astype(np.int32)
        in_range = (gate_idx >= 0) & (gate_idx < num_gates) & (range_km <= max_range_km)

        chunk_vals = np.full(flat_lon.shape[0], nodata, dtype=np.float32)
        if np.any(in_range):
            az_idx = circular_nearest_indices(sweep.azimuth_deg, azimuth[in_range])
            sample = sweep.reflectivity[az_idx, gate_idx[in_range]]
            sample = np.asarray(sample, dtype=np.float32)
            valid = np.isfinite(sample)

            idx_in = np.flatnonzero(in_range)
            valid_positions = idx_in[valid]
            chunk_vals[valid_positions] = sample[valid]

        out[y0:y1, :] = chunk_vals.reshape(y1 - y0, output_size)

    return out


def write_geotiff(
    path: Path,
    grid: np.ndarray,
    bounds: tuple[float, float, float, float],
    nodata: float,
) -> None:
    west, south, east, north = bounds
    path.parent.mkdir(parents=True, exist_ok=True)
    transform = from_bounds(west, south, east, north, grid.shape[1], grid.shape[0])

    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=grid.shape[1],
        height=grid.shape[0],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
        nodata=nodata,
        compress="deflate",
    ) as dst:
        dst.write(grid, 1)


def mobile_webp_path_for_geotiff(output_root: Path, geotiff_path: Path) -> Path:
    return output_root / MOBILE_WEBP_DIR / f"{geotiff_path.stem}.webp"


def downsample_grid_nearest(grid: np.ndarray, max_size: int = MOBILE_WEBP_MAX_SIZE) -> np.ndarray:
    height, width = grid.shape
    largest = max(height, width)
    if largest <= max_size:
        return grid

    scale = max_size / float(largest)
    out_width = max(1, int(round(width * scale)))
    out_height = max(1, int(round(height * scale)))

    y_idx = np.linspace(0, height - 1, out_height).round().astype(np.int32)
    x_idx = np.linspace(0, width - 1, out_width).round().astype(np.int32)
    return grid[np.ix_(y_idx, x_idx)]


def colorize_dbz_grid(grid: np.ndarray, nodata: float) -> np.ndarray:
    sampled = np.asarray(grid, dtype=np.float32)
    rgba = np.zeros((sampled.shape[0], sampled.shape[1], 4), dtype=np.uint8)

    valid = np.isfinite(sampled) & (sampled != nodata) & (sampled >= DISPLAY_MIN_DBZ)
    if not np.any(valid):
        return rgba

    values = sampled[valid].astype(np.float32)

    stops = np.asarray([stop[0] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    red = np.asarray([stop[1] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    green = np.asarray([stop[2] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    blue = np.asarray([stop[3] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)
    alpha = np.asarray([stop[4] for stop in RADAR_DBZ_PALETTE], dtype=np.float32)

    taper_stops = np.asarray([stop[0] for stop in LOW_DBZ_OPACITY_TAPER], dtype=np.float32)
    taper_values = np.asarray([stop[1] for stop in LOW_DBZ_OPACITY_TAPER], dtype=np.float32)

    rgba[..., 0][valid] = np.clip(np.interp(values, stops, red), 0, 255).astype(np.uint8)
    rgba[..., 1][valid] = np.clip(np.interp(values, stops, green), 0, 255).astype(np.uint8)
    rgba[..., 2][valid] = np.clip(np.interp(values, stops, blue), 0, 255).astype(np.uint8)

    base_alpha = np.interp(values, stops, alpha)
    taper_alpha = np.interp(values, taper_stops, taper_values)
    rgba[..., 3][valid] = np.clip(base_alpha * taper_alpha, 0, 255).astype(np.uint8)

    black_with_alpha = (
        (rgba[..., 0] == 0)
        & (rgba[..., 1] == 0)
        & (rgba[..., 2] == 0)
        & (rgba[..., 3] > 0)
    )
    rgba[..., 3][black_with_alpha] = 0

    return rgba


def write_mobile_webp(path: Path, grid: np.ndarray, nodata: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sampled = downsample_grid_nearest(grid)
    rgba = colorize_dbz_grid(sampled, nodata)
    image = Image.fromarray(rgba, mode="RGBA")
    image.save(path, format="WEBP", quality=MOBILE_WEBP_QUALITY, method=4)


def ensure_mobile_webps(output_root: Path, nodata: float) -> None:
    for geotiff_path in sorted(output_root.glob("*_projected_dbz.tif")):
        webp_path = mobile_webp_path_for_geotiff(output_root, geotiff_path)
        if webp_path.exists():
            continue
        with rasterio.open(geotiff_path) as src:
            grid = src.read(1).astype(np.float32)
            source_nodata = src.nodata if src.nodata is not None else nodata
        write_mobile_webp(webp_path, grid, float(source_nodata))


def prune_orphan_mobile_webps(output_root: Path) -> None:
    mobile_root = output_root / MOBILE_WEBP_DIR
    if not mobile_root.exists():
        return
    valid_stems = {frame_file.stem for frame_file in output_root.glob("*_projected_dbz.tif")}
    for webp_path in mobile_root.glob("*.webp"):
        if webp_path.stem not in valid_stems:
            webp_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render experimental Level II projected dBZ GeoTIFF.")
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--input", type=Path, default=None, help="Optional explicit Level II input file")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=None,
        help="Directory containing Level II source files (default: radar/source/level2/{site}).",
    )
    parser.add_argument(
        "--max-sources",
        type=int,
        default=MAX_LEVEL2_FRAMES,
        help=f"Maximum number of recent Level II source files to process (default: {MAX_LEVEL2_FRAMES}).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-render outputs even when projected GeoTIFF already exists.",
    )
    parser.add_argument(
        "--fetch-latest",
        action="store_true",
        help="Fetch latest raw Level II source scans from the public NEXRAD archive before rendering.",
    )
    parser.add_argument(
        "--source-count",
        type=int,
        default=MAX_LEVEL2_FRAMES,
        help=f"How many latest raw Level II source scans to keep/fetch (default: {MAX_LEVEL2_FRAMES}).",
    )
    parser.add_argument(
        "--source-bucket",
        default=DEFAULT_SOURCE_BUCKET,
        help=f"Public S3 bucket name for Level II source scans (default: {DEFAULT_SOURCE_BUCKET}).",
    )
    parser.add_argument(
        "--source-date",
        default=None,
        help="Optional anchor UTC date for fetch listing (YYYY/MM/DD or YYYY-MM-DD).",
    )
    parser.add_argument("--output-size", type=int, default=OUTPUT_SIZE)
    parser.add_argument("--nodata", type=float, default=NODATA)
    args = parser.parse_args()

    site = args.site.strip().upper()
    if not re.fullmatch(r"K[A-Z0-9]{3}", site):
        raise SystemExit(f"Unsupported Level II radar site ID: {site}")

    input_dir = args.input_dir or (LEVEL2_SOURCE_BASE / site)
    output_root = LEVEL2_OUTPUT_BASE / site / "LEVEL2" / "REF0"
    level2_frames_manifest = output_root / "frames.json"

    if args.fetch_latest:
        fetch_latest_source_scans(
            source_dir=input_dir,
            site=site,
            bucket=args.source_bucket.strip(),
            source_count=max(1, args.source_count),
            source_date=args.source_date,
            force=args.force,
        )

    # Input scan selection:
    # - --input renders one explicit file.
    # - Otherwise, render recent files from --input-dir (newest N), enabling multi-frame loops.
    source_paths = [args.input] if args.input else recent_level2_files(input_dir, max(1, args.max_sources))
    bounds = load_bounds_from_frames_json(site)
    latest_output_path: Path | None = None
    latest_valid_time = ""
    latest_source_name = ""

    for source_path in source_paths:
        slug_base = source_path.name
        match = KEY_RE.search(source_path.name)
        if match:
            slug_base = f"{match.group('site')}_{match.group('ts')}"
        output_path = output_root / f"{slug_base}_projected_dbz.tif"

        valid_time = infer_valid_time_from_name(source_path) or valid_time_from_projected_filename(output_path) or ""

        if output_path.exists() and not args.force:
            latest_output_path = output_path
            latest_valid_time = valid_time or "unknown"
            latest_source_name = source_path.name
            print(f"skipExistingOutput={output_path}")
            continue

        with source_path.open("rb") as handle:
            level2 = Level2File(handle)

        if getattr(level2, "dt", None):
            valid_time = format_utc_iso(level2.dt)
        if not valid_time:
            valid_time = valid_time_from_projected_filename(output_path) or "unknown"

        latest_output_path = output_path
        latest_valid_time = valid_time
        latest_source_name = source_path.name

        sweep = extract_lowest_reflectivity_sweep(level2)
        grid = build_projected_dbz_grid(
            sweep=sweep,
            bounds=bounds,
            output_size=args.output_size,
            nodata=args.nodata,
        )

        if grid.shape != (args.output_size, args.output_size):
            raise RuntimeError(f"Projected grid shape mismatch: {grid.shape}")

        write_geotiff(path=output_path, grid=grid, bounds=bounds, nodata=args.nodata)
        write_mobile_webp(mobile_webp_path_for_geotiff(output_root, output_path), grid, args.nodata)

        valid_mask = np.isfinite(grid) & (grid != args.nodata)
        valid_count = int(valid_mask.sum())
        nodata_count = int(grid.size - valid_count)
        finite_vals = grid[valid_mask]
        min_dbz = float(np.min(finite_vals)) if valid_count else math.nan
        max_dbz = float(np.max(finite_vals)) if valid_count else math.nan

        print(f"radarSite={site}")
        print(f"validTime={valid_time}")
        print(f"sweepElevationDeg={sweep.elevation_deg:.3f}")
        print(f"sourceShape={sweep.reflectivity.shape[0]}x{sweep.reflectivity.shape[1]}")
        print(f"outputShape={grid.shape[0]}x{grid.shape[1]}")
        print(f"finiteMinDbz={min_dbz if np.isfinite(min_dbz) else 'nan'}")
        print(f"finiteMaxDbz={max_dbz if np.isfinite(max_dbz) else 'nan'}")
        print(f"validPixels={valid_count}")
        print(f"nodataPixels={nodata_count}")
        print(f"outputPath={output_path}")

    if latest_output_path is None:
        raise RuntimeError("No Level II source files selected for rendering.")

    prune_level2_output_frames(output_root, MAX_LEVEL2_FRAMES)
    ensure_mobile_webps(output_root, args.nodata)
    prune_orphan_mobile_webps(output_root)

    latest_json = output_root / "latest.json"
    latest_json.write_text(
        json.dumps(
            {
                "site": site,
                "product": LEVEL2_PRODUCT,
                "sourceFile": str(latest_source_name),
                "validTime": latest_valid_time,
                "bounds": {
                    "west": bounds[0],
                    "south": bounds[1],
                    "east": bounds[2],
                    "north": bounds[3],
                },
                "path": f"/radar/tilesets/test/{site}/LEVEL2/REF0/{latest_output_path.name}",
                "imagePath": f"/radar/tilesets/test/{site}/LEVEL2/REF0/{MOBILE_WEBP_DIR}/{latest_output_path.stem}.webp",
                "width": int(args.output_size),
                "height": int(args.output_size),
                "nodata": args.nodata,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    frames_manifest = build_level2_frames_manifest(
        output_root=output_root,
        site=site,
        product=LEVEL2_PRODUCT,
        bounds=bounds,
        latest_frame_name=latest_output_path.name,
        latest_valid_time=latest_valid_time,
    )
    level2_frames_manifest.write_text(
        json.dumps(frames_manifest, indent=2),
        encoding="utf-8",
    )
    print(f"framesCount={len(frames_manifest.get('frames', []))}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
