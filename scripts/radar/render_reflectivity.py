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
DEFAULT_CARTESIAN_SIZE_PX = 1536
DEFAULT_CARTESIAN_SMOOTHING_PASSES = 0
DEFAULT_SAMPLING_MODE = "nearest"
DEFAULT_PALETTE_MODE = "radar-app-v1"


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


def rgba_for_dbz(value: float, color_table: dict | None = None) -> tuple[int, int, int, int]:
    table = color_table or DEFAULT_REFLECTIVITY_COLOR_TABLE
    color_entries = table["colors"]

    if value < color_entries[0]["value"]:
        return first_stop_rgba(color_entries[0])

    selected = color_entries[-1]

    for entry in color_entries:
        if value >= entry["value"]:
            selected = entry
        else:
            break

    return first_stop_rgba(selected)


def radar_app_rgba_for_dbz(value: float) -> tuple[int, int, int, int]:
    if value < -5:
        return 0, 0, 0, 0
    if value < 0:
        return 112, 128, 144, 25
    if value < 5:
        return 64, 80, 112, 55
    if value < 10:
        return 70, 130, 110, 95
    if value < 15:
        return 110, 200, 110, 175
    if value < 20:
        return 100, 220, 120, 220
    if value < 30:
        return 50, 205, 50, 255
    if value < 40:
        return 255, 215, 0, 255
    if value < 50:
        return 255, 140, 0, 255
    if value < 60:
        return 220, 40, 40, 255
    return 190, 0, 200, 255


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


def render_settings_number(value, default=None):
    if value is None:
        return default

    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default

    return numeric if math.isfinite(numeric) else default


def render_settings_int(value, default: int) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return default

    return numeric


def render_settings_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("1", "true", "yes", "on"):
            return True
        if normalized in ("0", "false", "no", "off"):
            return False

    return default


def normalized_color_table(value):
    if not isinstance(value, dict):
        return None

    colors = value.get("colors")
    if not isinstance(colors, list) or not colors:
        return None

    for entry in colors:
        if not isinstance(entry, dict):
            return None
        if "value" not in entry or not isinstance(entry.get("stops"), list) or not entry["stops"]:
            return None

        for stop in entry["stops"]:
            rgb = stop.get("rgb") if isinstance(stop, dict) else None
            if not isinstance(rgb, list) or len(rgb) != 3:
                return None

    return value


def normalized_opacity_taper(value):
    if not isinstance(value, dict):
        return None

    points = value.get("points")
    if not isinstance(points, list) or len(points) < 2:
        return None

    normalized_points = []
    for point in points:
        if not isinstance(point, dict):
            continue

        dbz = render_settings_number(point.get("dbz"))
        opacity = render_settings_number(point.get("opacity"))

        if dbz is None or opacity is None:
            continue

        normalized_points.append({
            "dbz": dbz,
            "opacity": min(1.0, max(0.0, opacity)),
        })

    if len(normalized_points) < 2:
        return None

    return {
        "enabled": render_settings_bool(value.get("enabled"), True),
        "points": sorted(normalized_points, key=lambda point: point["dbz"]),
    }


def normalized_speckle_dampen(value):
    if not isinstance(value, dict):
        return None

    return {
        "enabled": render_settings_bool(value.get("enabled"), False),
        "maximumDbz": render_settings_number(value.get("maximumDbz"), 10.0),
        "minimumNeighborPixels": max(
            0,
            render_settings_int(value.get("minimumNeighborPixels"), 2),
        ),
        "alphaMultiplier": min(
            1.0,
            max(0.0, render_settings_number(value.get("alphaMultiplier"), 0.45)),
        ),
    }


def normalized_radial_interpolation(value):
    if not isinstance(value, dict):
        return {
            "enabled": False,
            "strength": 0.0,
            "maximumDbz": 20.0,
            "preserveAboveDbz": 35.0,
            "mode": "weak-reflectivity-polar-blend",
        }

    maximum_dbz = render_settings_number(value.get("maximumDbz"), 20.0)
    preserve_above_dbz = render_settings_number(value.get("preserveAboveDbz"), 35.0)
    if preserve_above_dbz <= maximum_dbz:
        preserve_above_dbz = maximum_dbz + 1.0

    return {
        "enabled": render_settings_bool(value.get("enabled"), False),
        "strength": min(
            1.0,
            max(0.0, render_settings_number(value.get("strength"), 0.25)),
        ),
        "maximumDbz": maximum_dbz,
        "preserveAboveDbz": preserve_above_dbz,
        "mode": str(value.get("mode") or "weak-reflectivity-polar-blend"),
    }


def opacity_for_dbz(value: float, opacity_taper: dict | None) -> float:
    if not opacity_taper or not opacity_taper.get("enabled"):
        return 1.0

    points = opacity_taper["points"]
    if value <= points[0]["dbz"]:
        return points[0]["opacity"]
    if value >= points[-1]["dbz"]:
        return points[-1]["opacity"]

    for lower, upper in zip(points, points[1:]):
        if lower["dbz"] <= value <= upper["dbz"]:
            span = upper["dbz"] - lower["dbz"]
            if span <= 0:
                return upper["opacity"]
            ratio = (value - lower["dbz"]) / span
            return lower["opacity"] + (upper["opacity"] - lower["opacity"]) * ratio

    return 1.0


def reflectivity_rendering_settings(config: dict, args) -> dict:
    render_config = config.get("reflectivityRendering")
    if not isinstance(render_config, dict):
        render_config = {}

    custom_color_table = normalized_color_table(render_config.get("customColorTable"))
    palette = str(
        render_config.get("palette")
        or config.get("palette")
        or DEFAULT_PALETTE_MODE
    )
    color_table = custom_color_table if custom_color_table and palette == "customColorTable" else None

    return {
        "minimumDbz": render_settings_number(
            render_config.get("minimumDbz"),
            args.min_visible_dbz,
        ),
        "maximumDbz": render_settings_number(
            render_config.get("maximumDbz"),
            None,
        ),
        "minimumConnectedPixelBlobSize": max(
            1,
            render_settings_int(
                render_config.get("minimumConnectedPixelBlobSize"),
                args.min_component_pixels,
            ),
        ),
        "palette": palette,
        "colorTable": color_table,
        "lowDbzOpacityTaper": normalized_opacity_taper(render_config.get("lowDbzOpacityTaper")),
        "isolatedSpeckleDampen": normalized_speckle_dampen(render_config.get("isolatedSpeckleDampen")),
        "radialInterpolation": normalized_radial_interpolation(render_config.get("radialInterpolation")),
    }


def rgba_for_rendered_dbz(
    value: float,
    palette: str = DEFAULT_PALETTE_MODE,
    color_table: dict | None = None,
    maximum_dbz: float | None = None,
    opacity_taper: dict | None = None,
) -> tuple[int, int, int, int]:
    rendered_value = min(value, maximum_dbz) if maximum_dbz is not None else value

    if palette in ("DEFAULT_REFLECTIVITY_COLOR_TABLE", "customColorTable"):
        red, green, blue, alpha = rgba_for_dbz(rendered_value, color_table)
    else:
        red, green, blue, alpha = radar_app_rgba_for_dbz(rendered_value)

    alpha = int(round(alpha * opacity_for_dbz(value, opacity_taper)))
    return red, green, blue, min(255, max(0, alpha))


def neighbor_count_mask(mask):
    import numpy as np

    padded = np.pad(
        np.asarray(mask, dtype=bool).astype(np.uint8),
        1,
        mode="constant",
        constant_values=0,
    )
    return (
        padded[:-2, :-2]
        + padded[:-2, 1:-1]
        + padded[:-2, 2:]
        + padded[1:-1, :-2]
        + padded[1:-1, 2:]
        + padded[2:, :-2]
        + padded[2:, 1:-1]
        + padded[2:, 2:]
    )


def dampen_isolated_weak_speckles(rgba, numeric, visible_mask, speckle_dampen: dict | None):
    if not speckle_dampen or not speckle_dampen.get("enabled"):
        return 0

    import numpy as np

    maximum_dbz = speckle_dampen["maximumDbz"]
    minimum_neighbors = speckle_dampen["minimumNeighborPixels"]
    alpha_multiplier = speckle_dampen["alphaMultiplier"]
    neighbors = neighbor_count_mask(visible_mask)
    isolated_mask = (
        np.asarray(visible_mask, dtype=bool)
        & np.isfinite(numeric)
        & (numeric <= maximum_dbz)
        & (neighbors < minimum_neighbors)
    )
    dampened_pixels = int(isolated_mask.sum())

    if dampened_pixels:
        alpha = rgba[:, :, 3].astype(float)
        alpha[isolated_mask] = np.round(alpha[isolated_mask] * alpha_multiplier)
        rgba[:, :, 3] = np.clip(alpha, 0, 255).astype(np.uint8)

    return dampened_pixels


def reflectivity_to_rgba(
    values,
    min_visible_dbz: float = DEFAULT_MIN_VISIBLE_DBZ,
    min_component_pixels: int = DEFAULT_MIN_COMPONENT_PIXELS,
    maximum_dbz: float | None = None,
    palette: str = DEFAULT_PALETTE_MODE,
    color_table: dict | None = None,
    opacity_taper: dict | None = None,
    speckle_dampen: dict | None = None,
):
    import numpy as np

    numeric = np.asarray(np.ma.array(values).filled(np.nan), dtype=float)
    height, width = numeric.shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    finite_mask = np.isfinite(numeric)
    raw_visible_mask = finite_mask & (numeric >= min_visible_dbz)
    visible_mask = remove_small_components(raw_visible_mask, min_component_pixels)

    for y, x in zip(*np.nonzero(visible_mask)):
        rgba[y, x] = rgba_for_rendered_dbz(
            float(numeric[y, x]),
            palette,
            color_table,
            maximum_dbz,
            opacity_taper,
        )

    dampen_isolated_weak_speckles(rgba, numeric, visible_mask, speckle_dampen)
    rgba[~finite_mask] = [0, 0, 0, 0]
    rgba[finite_mask & ~visible_mask] = [0, 0, 0, 0]
    return rgba


def reflectivity_stats(
    values,
    min_visible_dbz: float = DEFAULT_MIN_VISIBLE_DBZ,
    min_component_pixels: int = DEFAULT_MIN_COMPONENT_PIXELS,
    maximum_dbz: float | None = None,
    speckle_dampen: dict | None = None,
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
    dampened_speckle_pixels = 0
    if speckle_dampen and speckle_dampen.get("enabled"):
        neighbors = neighbor_count_mask(visible_mask)
        dampened_speckle_pixels = int((
            visible_mask
            & finite_mask
            & (numeric <= speckle_dampen["maximumDbz"])
            & (neighbors < speckle_dampen["minimumNeighborPixels"])
        ).sum())
    visible_coverage = (visible_pixels / total_pixels * 100) if total_pixels else 0.0

    return {
        "minVisibleDbz": float(min_visible_dbz),
        "maxVisibleDbz": float(maximum_dbz) if maximum_dbz is not None else None,
        "minComponentPixels": int(min_component_pixels),
        "totalPixels": total_pixels,
        "finitePixels": finite_pixels,
        "rawVisiblePixels": raw_visible_pixels,
        "visiblePixels": visible_pixels,
        "removedSpecklePixels": removed_speckle_pixels,
        "dampenedSpecklePixels": dampened_speckle_pixels,
        "visibleCoveragePercent": visible_coverage,
        "finiteMin": float(np.nanmin(finite_values)) if finite_pixels else None,
        "finiteMax": float(np.nanmax(finite_values)) if finite_pixels else None,
        "finiteMean": float(np.nanmean(finite_values)) if finite_pixels else None,
    }


def sample_polar_bilinear(source, azimuth_float, gate_float):
    import numpy as np

    numeric = np.asarray(np.ma.array(source).filled(np.nan), dtype=float)
    azimuth_count, gate_count = numeric.shape

    az0 = np.floor(azimuth_float).astype(int) % azimuth_count
    az1 = (az0 + 1) % azimuth_count
    gate0 = np.clip(np.floor(gate_float).astype(int), 0, gate_count - 1)
    gate1 = np.clip(gate0 + 1, 0, gate_count - 1)
    az_weight = azimuth_float - np.floor(azimuth_float)
    gate_weight = gate_float - np.floor(gate_float)

    samples = [
        (numeric[az0, gate0], (1.0 - az_weight) * (1.0 - gate_weight)),
        (numeric[az1, gate0], az_weight * (1.0 - gate_weight)),
        (numeric[az0, gate1], (1.0 - az_weight) * gate_weight),
        (numeric[az1, gate1], az_weight * gate_weight),
    ]
    numerator = np.zeros_like(azimuth_float, dtype=float)
    denominator = np.zeros_like(azimuth_float, dtype=float)

    for values, weights in samples:
        finite = np.isfinite(values)
        numerator[finite] += values[finite] * weights[finite]
        denominator[finite] += weights[finite]

    sampled = np.full_like(azimuth_float, np.nan, dtype=float)
    valid = denominator > 0
    sampled[valid] = numerator[valid] / denominator[valid]
    return sampled


def sample_polar_nearest(source, azimuth_float, gate_float):
    import numpy as np

    numeric = np.asarray(np.ma.array(source).filled(np.nan), dtype=float)
    azimuth_count, gate_count = numeric.shape

    azimuth_index = np.rint(azimuth_float).astype(int) % azimuth_count
    gate_index = np.clip(np.rint(gate_float).astype(int), 0, gate_count - 1)
    return numeric[azimuth_index, gate_index]


def normalize_azimuths(azimuths, expected_count: int):
    import numpy as np

    if azimuths is None:
        return None

    numeric = np.asarray(np.ma.array(azimuths).filled(np.nan), dtype=float).reshape(-1)

    if numeric.size != expected_count:
        return None

    if not np.isfinite(numeric).all():
        return None

    return np.mod(numeric, 360.0)


def circular_midpoint_degrees(start_azimuths, end_azimuths):
    import numpy as np

    start = np.asarray(np.ma.array(start_azimuths).filled(np.nan), dtype=float).reshape(-1)
    end = np.asarray(np.ma.array(end_azimuths).filled(np.nan), dtype=float).reshape(-1)

    if start.size != end.size:
        return None

    delta = np.mod(end - start, 360.0)
    return np.mod(start + (delta / 2.0), 360.0)


def radial_azimuth_indices(target_degrees, row_azimuths):
    import numpy as np

    sorted_angles = np.asarray(row_azimuths, dtype=float)
    row_count = sorted_angles.size

    if row_count < 2:
        return None

    targets = np.mod(target_degrees, 360.0)
    targets = np.where(targets < sorted_angles[0], targets + 360.0, targets)
    angle_axis = np.concatenate([sorted_angles, [sorted_angles[0] + 360.0]])
    index_axis = np.concatenate([np.arange(row_count, dtype=float), [float(row_count)]])
    return np.mod(np.interp(targets, angle_axis, index_axis), row_count)


def prepare_azimuth_sample_source(values, azimuth_degrees_by_row):
    import numpy as np

    numeric = np.asarray(np.ma.array(values).filled(np.nan), dtype=float)
    azimuth_count = numeric.shape[0]
    row_azimuths = normalize_azimuths(azimuth_degrees_by_row, azimuth_count)

    if row_azimuths is None:
        return numeric, None, "row-index-fallback"

    order = np.argsort(row_azimuths, kind="stable")
    sorted_azimuths = row_azimuths[order]
    sorted_numeric = numeric[order]

    if np.unique(np.round(sorted_azimuths, 6)).size < 2:
        return numeric, None, "row-index-fallback"

    return sorted_numeric, sorted_azimuths, "azimuth-aware"


def polar_reflectivity_to_cartesian_grid(
    values,
    range_km: float,
    output_size_px: int = DEFAULT_CARTESIAN_SIZE_PX,
    sampling_mode: str = DEFAULT_SAMPLING_MODE,
    azimuth_degrees_by_row=None,
    radial_interpolation: dict | None = None,
):
    import numpy as np

    numeric, sorted_azimuths, azimuth_mapping_mode = prepare_azimuth_sample_source(
        values,
        azimuth_degrees_by_row,
    )
    azimuth_count, gate_count = numeric.shape
    output_grid = np.full((output_size_px, output_size_px), np.nan, dtype=float)
    axis_km = np.linspace(-range_km, range_km, output_size_px)
    x_km, y_km = np.meshgrid(axis_km, axis_km[::-1])
    range_at_pixel = np.hypot(x_km, y_km)
    in_range = range_at_pixel <= range_km

    azimuth_degrees = np.degrees(np.arctan2(x_km[in_range], y_km[in_range]))
    azimuth_degrees = np.where(azimuth_degrees < 0, azimuth_degrees + 360.0, azimuth_degrees)
    if sorted_azimuths is not None:
        azimuth_index_float = radial_azimuth_indices(azimuth_degrees, sorted_azimuths)
    else:
        azimuth_index_float = azimuth_degrees / 360.0 * azimuth_count
    gate_index_float = range_at_pixel[in_range] / range_km * (gate_count - 1)

    if sampling_mode == "nearest":
        sampled_values = sample_polar_nearest(numeric, azimuth_index_float, gate_index_float)
        if radial_interpolation and radial_interpolation.get("enabled"):
            interpolated_values = sample_polar_bilinear(numeric, azimuth_index_float, gate_index_float)
            finite_pair = np.isfinite(sampled_values) & np.isfinite(interpolated_values)
            if finite_pair.any():
                maximum_dbz = radial_interpolation["maximumDbz"]
                preserve_above_dbz = radial_interpolation["preserveAboveDbz"]
                strength = radial_interpolation["strength"]
                blend = np.zeros_like(sampled_values, dtype=float)
                blend[finite_pair] = np.where(
                    sampled_values[finite_pair] <= maximum_dbz,
                    strength,
                    np.where(
                        sampled_values[finite_pair] >= preserve_above_dbz,
                        0.0,
                        strength
                        * (
                            (preserve_above_dbz - sampled_values[finite_pair])
                            / (preserve_above_dbz - maximum_dbz)
                        ),
                    ),
                )
                sampled_values[finite_pair] = (
                    sampled_values[finite_pair] * (1.0 - blend[finite_pair])
                    + interpolated_values[finite_pair] * blend[finite_pair]
                )
    else:
        sampled_values = sample_polar_bilinear(numeric, azimuth_index_float, gate_index_float)

    output_grid[in_range] = sampled_values
    return output_grid, azimuth_mapping_mode


def smooth_cartesian_grid(grid, passes=1):
    import numpy as np

    smoothed = np.asarray(grid, dtype=float).copy()

    for _pass_index in range(max(0, int(passes))):
        finite_mask = np.isfinite(smoothed)

        if not finite_mask.any():
            break

        values = np.where(finite_mask, smoothed, 0.0)
        padded_values = np.pad(values, 1, mode="constant", constant_values=0.0)
        padded_counts = np.pad(finite_mask.astype(float), 1, mode="constant", constant_values=0.0)
        neighbor_sum = np.zeros_like(smoothed, dtype=float)
        neighbor_count = np.zeros_like(smoothed, dtype=float)

        for dy in range(3):
            for dx in range(3):
                neighbor_sum += padded_values[dy:dy + smoothed.shape[0], dx:dx + smoothed.shape[1]]
                neighbor_count += padded_counts[dy:dy + smoothed.shape[0], dx:dx + smoothed.shape[1]]

        next_grid = smoothed.copy()
        replace_mask = finite_mask & (neighbor_count > 0)
        next_grid[replace_mask] = neighbor_sum[replace_mask] / neighbor_count[replace_mask]
        smoothed = next_grid

    return smoothed


def polar_reflectivity_to_cartesian_rgba(
    values,
    radar_lat: float,
    radar_lon: float,
    range_km: float,
    output_size_px: int = DEFAULT_CARTESIAN_SIZE_PX,
    min_visible_dbz: float = DEFAULT_MIN_VISIBLE_DBZ,
    min_component_pixels: int = DEFAULT_MIN_COMPONENT_PIXELS,
    maximum_dbz: float | None = None,
    palette: str = DEFAULT_PALETTE_MODE,
    color_table: dict | None = None,
    opacity_taper: dict | None = None,
    speckle_dampen: dict | None = None,
    radial_interpolation: dict | None = None,
    smoothing_passes: int = DEFAULT_CARTESIAN_SMOOTHING_PASSES,
    sampling_mode: str = DEFAULT_SAMPLING_MODE,
    azimuth_degrees_by_row=None,
):
    del radar_lat, radar_lon

    cartesian_grid, azimuth_mapping_mode = polar_reflectivity_to_cartesian_grid(
        values,
        range_km,
        output_size_px,
        sampling_mode,
        azimuth_degrees_by_row,
        radial_interpolation,
    )
    cartesian_grid = smooth_cartesian_grid(cartesian_grid, smoothing_passes)
    rgba = reflectivity_to_rgba(
        cartesian_grid,
        min_visible_dbz,
        min_component_pixels,
        maximum_dbz,
        palette,
        color_table,
        opacity_taper,
        speckle_dampen,
    )
    return rgba, cartesian_grid, azimuth_mapping_mode


def catalog_product_metadata(product: str) -> dict:
    return {
        "id": product,
        "label": "Super-Res Base Reflectivity" if product == "N0B" else product,
        "units": "dBZ",
        "palette": "DEFAULT_REFLECTIVITY_COLOR_TABLE",
    }


def safe_frame_count(value) -> int:
    try:
        frame_count = int(value)
    except (TypeError, ValueError):
        return 1

    return frame_count if frame_count > 0 else 1


def frame_sort_key(frame: dict) -> str:
    return str(frame.get("validTime") or "")


def source_file_valid_time(path: Path) -> datetime | None:
    meta = source_metadata(path)
    if not meta:
        return None

    try:
        return datetime.strptime(
            valid_time_from_metadata(meta),
            "%Y-%m-%dT%H:%M:%SZ",
        ).replace(tzinfo=timezone.utc)
    except (KeyError, ValueError):
        return None


def source_file_sort_key(path: Path) -> tuple[int, datetime]:
    valid_time = source_file_valid_time(path)
    if valid_time is None:
        return (0, datetime.min.replace(tzinfo=timezone.utc))

    return (1, valid_time)


def source_file_valid_time_label(path: Path) -> str:
    valid_time = source_file_valid_time(path)
    if valid_time is None:
        return "unparsed"

    return valid_time.isoformat().replace("+00:00", "Z")


def update_frames_catalog(
    catalog_path: Path,
    frame_entry: dict,
    site: str,
    sector: str,
    product: str,
    frame_count: int = 1,
) -> None:
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    max_frames = safe_frame_count(frame_count)

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
    existing_frames = catalog["frames"][site].setdefault(product, [])
    new_slug = frame_entry.get("slug")
    replaced = False

    for index, existing_frame in enumerate(existing_frames):
        if existing_frame.get("slug") == new_slug:
            existing_frames[index] = frame_entry
            replaced = True
            break

    if not replaced:
        existing_frames.append(frame_entry)

    catalog["frames"][site][product] = sorted(
        existing_frames,
        key=frame_sort_key,
        reverse=True,
    )[:max_frames]

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
    level3, mapped, azimuth_degrees_by_row = decode_level3_mapped_data(path)

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
        if azimuth_degrees_by_row is not None:
            print(f"azimuthMetadataRows={len(azimuth_degrees_by_row)}")
        else:
            print("azimuthMetadataRows=0")
        print("Decode succeeded, but final WebP rendering is intentionally blocked unless --render is provided.")
        return True

    print("No mappable data arrays were found; no frame was generated.")
    return False


def extract_radial_azimuths(item: dict, expected_count: int):
    if "start_az" in item and "end_az" in item:
        return normalize_azimuths(
            circular_midpoint_degrees(item["start_az"], item["end_az"]),
            expected_count,
        )

    if "start_az" in item:
        return normalize_azimuths(item["start_az"], expected_count)

    if "end_az" in item:
        return normalize_azimuths(item["end_az"], expected_count)

    return None


def decode_level3_mapped_data(path: Path):
    try:
        from metpy.io import Level3File
    except ImportError as error:
        print("MetPy is not installed; cannot decode Level III NIDS data.")
        print("Install renderer dependencies with: pip install -r scripts/radar/requirements.txt")
        print(f"Import error: {error}")
        return None, None, None

    try:
        level3 = Level3File(str(path))
    except Exception as error:
        print(f"MetPy failed to open {path}: {error}")
        return None, None, None

    mapped = None
    azimuth_degrees_by_row = None

    sym_block = getattr(level3, "sym_block", []) or []

    if sym_block and sym_block[0] and isinstance(sym_block[0][0], dict):
        item = sym_block[0][0]

        if "data" in item:
            try:
                mapped = level3.map_data(item["data"])
                azimuth_degrees_by_row = extract_radial_azimuths(item, mapped.shape[0])
            except Exception as error:
                print(f"MetPy decoded the file, but map_data failed: {error}")

    return level3, mapped, azimuth_degrees_by_row


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


def render_level3_frame(source_file: Path, args, config: dict) -> bool:
    level3, mapped, azimuth_degrees_by_row = decode_level3_mapped_data(source_file)

    if level3 is None or mapped is None:
        print("No WebP/PNG frame was created.")
        return False

    meta = source_metadata(source_file)
    site = f"K{meta['sector']}"
    product = meta["product"]
    slug = f"{product}_{meta['date']}_{meta['time']}"
    frame_dir = REPO_ROOT / "radar" / "frames" / site / product
    frame_dir.mkdir(parents=True, exist_ok=True)
    frame_path = frame_dir / f"{slug}.webp"

    lat = float(getattr(level3, "lat"))
    lon = float(getattr(level3, "lon"))
    range_km = float(getattr(level3, "max_range"))
    mapped_shape = [int(dimension) for dimension in mapped.shape]
    bounds = calculate_rough_bounds(lat, lon, range_km)
    rendering = reflectivity_rendering_settings(config, args)
    minimum_dbz = rendering["minimumDbz"]
    maximum_dbz = rendering["maximumDbz"]
    minimum_blob_size = rendering["minimumConnectedPixelBlobSize"]
    palette = rendering["palette"]
    color_table = rendering["colorTable"]
    opacity_taper = rendering["lowDbzOpacityTaper"]
    speckle_dampen = rendering["isolatedSpeckleDampen"]
    radial_interpolation = rendering["radialInterpolation"]

    from PIL import Image

    rgba, cartesian_grid, azimuth_mapping_mode = polar_reflectivity_to_cartesian_rgba(
        mapped,
        lat,
        lon,
        range_km,
        DEFAULT_CARTESIAN_SIZE_PX,
        minimum_dbz,
        minimum_blob_size,
        maximum_dbz,
        palette,
        color_table,
        opacity_taper,
        speckle_dampen,
        radial_interpolation,
        args.smoothing_passes,
        args.sampling_mode,
        azimuth_degrees_by_row,
    )
    stats = reflectivity_stats(cartesian_grid, minimum_dbz, minimum_blob_size, maximum_dbz, speckle_dampen)
    source_stats = reflectivity_stats(mapped, minimum_dbz, minimum_blob_size, maximum_dbz, speckle_dampen)
    image = Image.fromarray(rgba, mode="RGBA")
    image.save(frame_path, "WEBP", lossless=True)

    relative_url = "/" + frame_path.relative_to(REPO_ROOT).as_posix()
    sampling_mode = args.sampling_mode
    if sampling_mode == "nearest":
        radial_blend_enabled = bool(radial_interpolation and radial_interpolation.get("enabled"))
        if radial_blend_enabled:
            projection_mode = "polar-cartesian-radial-blend-v1"
            output_image_mode = "north-up-cartesian-nearest-plus-radial-blend"
        else:
            projection_mode = (
                "polar-cartesian-azimuth-aware-nearest-v1"
                if azimuth_mapping_mode == "azimuth-aware"
                else "polar-cartesian-nearest-v2"
            )
            output_image_mode = "north-up-cartesian-nearest-sampled"
    else:
        projection_mode = (
            "polar-cartesian-azimuth-aware-bilinear-v1"
            if azimuth_mapping_mode == "azimuth-aware"
            else "polar-cartesian-bilinear-v1"
        )
        output_image_mode = "north-up-cartesian-bilinear-sampled"

    frame_entry = {
        "slug": slug,
        "url": relative_url,
        "validTime": valid_time_from_metadata(meta),
        "bounds": bounds,
        "width": image.width,
        "height": image.height,
        "palette": palette,
        "stats": stats,
        "sourceStats": source_stats,
        "debug": {
            "radarLat": lat,
            "radarLon": lon,
            "maxRangeKm": range_km,
            "mappedShape": mapped_shape,
            "cartesianSizePx": DEFAULT_CARTESIAN_SIZE_PX,
            "imageWidth": image.width,
            "imageHeight": image.height,
            "calculatedBounds": bounds,
            "smoothingPasses": int(args.smoothing_passes),
            "sourceImageMode": "azimuth-range",
            "outputImageMode": output_image_mode,
            "projectionMode": projection_mode,
            "samplingMode": sampling_mode,
            "azimuthMappingMode": azimuth_mapping_mode,
            "azimuthMetadataRows": int(len(azimuth_degrees_by_row)) if azimuth_degrees_by_row is not None else 0,
            "paletteMode": palette,
            "maximumDbz": maximum_dbz,
            "minimumDbz": minimum_dbz,
            "minimumConnectedPixelBlobSize": minimum_blob_size,
            "customColorTable": bool(color_table),
            "lowDbzOpacityTaper": bool(opacity_taper and opacity_taper.get("enabled")),
            "isolatedSpeckleDampen": bool(speckle_dampen and speckle_dampen.get("enabled")),
            "radialInterpolation": radial_interpolation,
        },
    }

    update_frames_catalog(
        REPO_ROOT / config.get("catalogPath", "radar/frames.json"),
        frame_entry,
        site,
        meta["sector"],
        product,
        config.get("frameCount"),
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
    print(f"samplingMode={sampling_mode}")
    print(f"azimuthMappingMode={azimuth_mapping_mode}")
    print(f"azimuthMetadataRows={len(azimuth_degrees_by_row) if azimuth_degrees_by_row is not None else 0}")
    print(f"paletteMode={palette}")
    print(f"maximumDbz={maximum_dbz}")
    print(f"radialInterpolation.enabled={radial_interpolation['enabled']}")
    print(f"radialInterpolation.strength={radial_interpolation['strength']}")
    print(f"radialInterpolation.maximumDbz={radial_interpolation['maximumDbz']}")
    print(f"radialInterpolation.preserveAboveDbz={radial_interpolation['preserveAboveDbz']}")
    print(f"smoothingPasses={int(args.smoothing_passes)}")
    print(f"minVisibleDbz={stats['minVisibleDbz']}")
    print(f"minComponentPixels={stats['minComponentPixels']}")
    print(f"rawVisiblePixels={stats['rawVisiblePixels']}")
    print(f"visiblePixelsAfterDespeckle={stats['visiblePixels']}")
    print(f"removedSpecklePixels={stats['removedSpecklePixels']}")
    print(f"dampenedSpecklePixels={stats['dampenedSpecklePixels']}")
    print(f"visibleCoveragePercent={stats['visibleCoveragePercent']:.6f}")
    return True


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
        "--smoothing-passes",
        type=int,
        default=DEFAULT_CARTESIAN_SMOOTHING_PASSES,
        help="Number of light smoothing passes to apply to the Cartesian dBZ grid.",
    )
    parser.add_argument(
        "--sampling-mode",
        choices=["nearest", "bilinear"],
        default=DEFAULT_SAMPLING_MODE,
        help="Polar-to-Cartesian sampling mode.",
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
    rendering = reflectivity_rendering_settings(config, args)
    print(f"reflectivityRendering.minimumDbz={rendering['minimumDbz']}")
    print(f"reflectivityRendering.maximumDbz={rendering['maximumDbz']}")
    print(
        "reflectivityRendering.minimumConnectedPixelBlobSize="
        f"{rendering['minimumConnectedPixelBlobSize']}"
    )
    print(f"reflectivityRendering.palette={rendering['palette']}")
    print(f"reflectivityRendering.customColorTable={bool(rendering['colorTable'])}")
    print(
        "reflectivityRendering.lowDbzOpacityTaper="
        f"{bool(rendering['lowDbzOpacityTaper'] and rendering['lowDbzOpacityTaper'].get('enabled'))}"
    )
    print(
        "reflectivityRendering.isolatedSpeckleDampen="
        f"{bool(rendering['isolatedSpeckleDampen'] and rendering['isolatedSpeckleDampen'].get('enabled'))}"
    )
    radial_interpolation = rendering["radialInterpolation"]
    print(f"reflectivityRendering.radialInterpolation.enabled={radial_interpolation['enabled']}")
    print(f"reflectivityRendering.radialInterpolation.strength={radial_interpolation['strength']}")
    print(f"reflectivityRendering.radialInterpolation.maximumDbz={radial_interpolation['maximumDbz']}")
    print(
        "reflectivityRendering.radialInterpolation.preserveAboveDbz="
        f"{radial_interpolation['preserveAboveDbz']}"
    )

    if not config.get("enabled") and not (args.force or args.diagnose or args.render):
        print("Renderer is disabled; no frames will be rendered. Pass --diagnose for a manual decode inspection.")
        return 0

    if args.dry_run:
        print("Dry run: would decode Level III N0B and render transparent frames.")
        return 0

    source_files = sorted(
        args.source_cache.glob("Level3_*_N0B_*.nids"),
        key=lambda path: (source_file_sort_key(path), path.name),
    )

    if not source_files:
        print(f"No Level III N0B source files found in {args.source_cache}.")
        return 1

    frame_count = safe_frame_count(config.get("frameCount"))
    selected_source_files = source_files[-frame_count:]
    print(f"Found {len(source_files)} Level III N0B source file(s) in {args.source_cache}.")
    print(f"Selected {len(selected_source_files)} newest source file(s) for frameCount={frame_count}.")

    decoded_all = True
    for index, source_file in enumerate(selected_source_files, start=1):
        valid_time = source_file_valid_time_label(source_file)
        print(f"Source file {index}/{len(selected_source_files)}: {source_file} validTime={valid_time}")
        decoded = inspect_level3_file(source_file)

        if not decoded:
            decoded_all = False
            print("No WebP/PNG frame was created.")

            if args.render:
                return 2

        if args.render and not render_level3_frame(source_file, args, config):
            return 2

    if args.diagnose:
        print("Diagnostic mode complete. Stopping before image generation.")
        print("No WebP/PNG frame was created.")
        return 0 if decoded_all else 2

    if args.render:
        print(f"Rendered {len(selected_source_files)} frame(s).")
        return 0

    # TODO: Apply DEFAULT_REFLECTIVITY_COLOR_TABLE from the frontend contract.
    # TODO: Render transparent WebP or PNG frames.
    # TODO: Calculate geographic bounds for each output image.
    # TODO: Write frames to radar/frames/{site}/{product}/{slug}.webp.
    print("No WebP/PNG frame was created.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
