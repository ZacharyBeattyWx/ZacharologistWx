import io
import json
import math
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone

import boto3
import numpy as np
from botocore import UNSIGNED
from botocore.config import Config
from netCDF4 import Dataset
from PIL import Image
from pyproj import CRS, Transformer


TARGET_BUCKET = os.environ["RADAR_BUCKET"]
TARGET_PREFIX = os.getenv(
    "SATELLITE_TRUECOLOR_PREFIX",
    "satellite-truecolor",
).strip("/")
NATIVE_PREFIX = os.getenv(
    "SATELLITE_NATIVE_PREFIX",
    "satellite-native",
).strip("/")

NATIVE_RENDER_VERSIONS = {
    "clean-ir": 6,
    "air-mass": 2,
    "simple-water-vapor": 2,
    "day-cloud-phase": 3,
}
CLEAN_IR_PALETTE_ID = "cod-style-clean-ir-v2"

FRAME_COUNT = int(os.getenv("SATELLITE_TRUECOLOR_FRAME_COUNT", "25"))
MAX_RENDER_PER_PLATFORM = int(
    os.getenv("SATELLITE_TRUECOLOR_MAX_RENDER_PER_PLATFORM", "2")
)
OUTPUT_WIDTH = int(os.getenv("SATELLITE_TRUECOLOR_WIDTH", "2200"))
NATIVE_REGIONAL_WIDTH = max(
    960, int(os.getenv("SATELLITE_NATIVE_REGIONAL_WIDTH", "4400"))
)
WEBP_QUALITY = int(os.getenv("SATELLITE_TRUECOLOR_WEBP_QUALITY", "88"))
MIN_DAYLIGHT_FRACTION = float(
    os.getenv("SATELLITE_TRUECOLOR_MIN_DAYLIGHT_FRACTION", "0.06")
)
HISTORY_HOURS = int(os.getenv("SATELLITE_TRUECOLOR_SCAN_HOURS", "16"))

PUBLISH_MODE = os.getenv(
    "SATELLITE_TRUECOLOR_MODE",
    "regional",
).strip().lower()

MAX_RENDER_FULLDISK_PER_PLATFORM = int(
    os.getenv(
        "SATELLITE_TRUECOLOR_MAX_RENDER_FULLDISK_PER_PLATFORM",
        "1",
    )
)

RENDER_VERSION = int(
    os.getenv("SATELLITE_TRUECOLOR_RENDER_VERSION", "3")
)

TRUECOLOR_BLACK_POINT = float(
    os.getenv("SATELLITE_TRUECOLOR_BLACK_POINT", "0.002")
)
TRUECOLOR_WHITE_POINT = float(
    os.getenv("SATELLITE_TRUECOLOR_WHITE_POINT", "0.86")
)
TRUECOLOR_GAMMA = float(
    os.getenv("SATELLITE_TRUECOLOR_GAMMA", "2.0")
)
TRUECOLOR_SATURATION = float(
    os.getenv("SATELLITE_TRUECOLOR_SATURATION", "1.22")
)
TRUECOLOR_CONTRAST = float(
    os.getenv("SATELLITE_TRUECOLOR_CONTRAST", "1.12")
)
TRUECOLOR_VIBRANCE = float(
    os.getenv("SATELLITE_TRUECOLOR_VIBRANCE", "0.16")
)
TRUECOLOR_DEHAZE_FLOOR = float(
    os.getenv("SATELLITE_TRUECOLOR_DEHAZE_FLOOR", "0.035")
)
TRUECOLOR_LOW_SUN_REFLECTANCE_GAIN = float(
    os.getenv("SATELLITE_TRUECOLOR_LOW_SUN_REFLECTANCE_GAIN", "2.8")
)
TRUECOLOR_LOW_SUN_START_DEGREES = float(
    os.getenv("SATELLITE_TRUECOLOR_LOW_SUN_START_DEGREES", "25.0")
)
TRUECOLOR_LOW_SUN_PLATEAU_DEGREES = float(
    os.getenv("SATELLITE_TRUECOLOR_LOW_SUN_PLATEAU_DEGREES", "4.0")
)
TRUECOLOR_TERMINATOR_FEATHER_DEGREES = float(
    os.getenv("SATELLITE_TRUECOLOR_TERMINATOR_FEATHER_DEGREES", "0.08")
)
TRUECOLOR_DAYLIGHT_CUTOFF_DEGREES = float(
    os.getenv("SATELLITE_TRUECOLOR_DAYLIGHT_CUTOFF_DEGREES", "4.0")
)
LOCALIZED_RENDER_VERSION = int(
    os.getenv("SATELLITE_LOCALIZED_RENDER_VERSION", "7")
)
LOCALIZED_MAX_RENDER_PER_SECTOR = int(
    os.getenv("SATELLITE_LOCALIZED_MAX_RENDER_PER_SECTOR", "2")
)
LOCALIZED_DEHAZE_STRENGTH = float(
    os.getenv("SATELLITE_LOCALIZED_DEHAZE_STRENGTH", "0.06")
)

REGIONAL_PLATFORMS = {
    "East": {
        "platform": "East",
        "satellite": "GOES-19",
        "source_bucket": os.getenv("SATELLITE_EAST_BUCKET", "noaa-goes19"),
        "source_product": "ABI-L1b-RadC",
        "prefix": "east",
        "sector": "CONUS",
        "cadence_minutes": 5,
        "max_render": MAX_RENDER_PER_PLATFORM,
        "render_version": 15,
        "dehaze_floor": TRUECOLOR_DEHAZE_FLOOR,
        "night_channel": "13",
        "native_products": True,
        "c02_stride": 1,
        "subsatellite_longitude": -75.2,

        # Keep the currently deployed regional footprint unchanged for now.
        # The viewer will be switched back to a clean RadC sector after the
        # Full Disk feed has been visually verified.
        "bbox": (-126.0, 22.0, -58.0, 53.0),
    },
    "West": {
        "platform": "West",
        "satellite": "GOES-18",
        "source_bucket": os.getenv("SATELLITE_WEST_BUCKET", "noaa-goes18"),
        "source_product": "ABI-L1b-RadC",
        "prefix": "west",
        "sector": "PACUS",
        "cadence_minutes": 5,
        "max_render": MAX_RENDER_PER_PLATFORM,
        "render_version": 15,
        "dehaze_floor": TRUECOLOR_DEHAZE_FLOOR,
        "night_channel": "13",
        "native_products": True,
        "c02_stride": 1,
        "subsatellite_longitude": -137.2,
        "bbox": (-134.0, 20.0, -101.0, 53.0),
    },
}

LOCALIZED_SECTORS = {
    "East": {
        "nr": (-117.5, 38.0, -99.5, 50.5),
        "umv": (-102.0, 35.5, -83.5, 49.5),
        "cgl": (-95.0, 37.0, -74.0, 50.0),
        "ne": (-84.0, 36.0, -65.5, 48.5),
        "sr": (-117.5, 28.5, -98.5, 42.5),
        "sp": (-107.0, 23.5, -87.5, 39.5),
        "smv": (-102.0, 23.5, -82.5, 39.5),
        "se": (-95.0, 23.5, -73.5, 39.0),
        "eus": (-87.0, 22.5, -60.5, 49.0),
    },
    "West": {
        "pnw": (-131.0, 37.5, -104.5, 55.5),
        "psw": (-128.0, 23.0, -99.5, 43.0),
    },
}

GLOBAL_PLATFORMS = {
    "East": {
        "platform": "East",
        "satellite": "GOES-19",
        "source_bucket": os.getenv("SATELLITE_EAST_BUCKET", "noaa-goes19"),
        "source_product": "ABI-L1b-RadF",
        "prefix": "east-global",
        "sector": "GLOBAL",
        "cadence_minutes": 10,
        "max_render": MAX_RENDER_FULLDISK_PER_PLATFORM,
        "render_version": 19,
        "night_channel": "13",
        "native_products": True,

        # Wider landscape North America / western Atlantic presentation
        # sourced from the actual ABI Full Disk scan.
        "bbox": (-148.0, 10.0, -37.0, 60.0),

        # Terminator-composite mode:
        # publish whenever a meaningful portion of the broad sector still
        # contains reflected-light signal. The viewer will mask nighttime
        # pixels with GeoColor using the calculated solar terminator.
    },
    "West": {
        "platform": "West",
        "satellite": "GOES-18",
        "source_bucket": os.getenv("SATELLITE_WEST_BUCKET", "noaa-goes18"),
        "source_product": "ABI-L1b-RadF",
        "prefix": "west-global",
        "sector": "GLOBAL",
        "cadence_minutes": 10,
        "max_render": MAX_RENDER_FULLDISK_PER_PLATFORM,
        "render_version": 19,
        "night_channel": "13",
        "native_products": True,

        # Pacific-centered broad North America presentation.
        "bbox": (-175.0, 5.0, -70.0, 65.0),
    },
}

if PUBLISH_MODE == "global":
    PLATFORMS = GLOBAL_PLATFORMS
else:
    PLATFORMS = REGIONAL_PLATFORMS


SOURCE_S3 = boto3.client(
    "s3",
    region_name="us-east-1",
    config=Config(
        signature_version=UNSIGNED,
        retries={"max_attempts": 4, "mode": "standard"},
    ),
)
TARGET_S3 = boto3.client("s3")

# ABI L1b CONUS/PACUS files contain one channel each. Group files by scan
# minute so the three reflective channels from the same five-minute scan
# are rendered together.
SOURCE_RE = re.compile(
    r"-M\dC(?P<channel>01|02|03|13)_G\d+_s(?P<scan>\d{11})"
)
NATIVE_SOURCE_RE = re.compile(
    r"-M\dC(?P<channel>02|05|08|10|12|13)_G\d+_s(?P<scan>\d{11})"
)


def utcnow():
    return datetime.now(timezone.utc)


def iso_z(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_scan(scan):
    return datetime.strptime(scan, "%Y%j%H%M").replace(tzinfo=timezone.utc)


def source_hour_prefix(spec, dt):
    return (
        f"{spec['source_product']}/"
        f"{dt:%Y}/{dt:%j}/{dt:%H}/"
    )


def manifest_key(spec):
    return f"{TARGET_PREFIX}/{spec['prefix']}/manifest.json"


def frame_key(spec, scan_dt):
    stamp = scan_dt.strftime("%Y%m%dT%H%M00Z")
    render_version = int(
        spec.get("render_version", RENDER_VERSION)
    )
    return (
        f"{TARGET_PREFIX}/{spec['prefix']}/frames/"
        f"v{render_version}/{stamp}.webp"
    )


def read_manifest(spec):
    try:
        response = TARGET_S3.get_object(
            Bucket=TARGET_BUCKET,
            Key=manifest_key(spec),
        )
        data = json.loads(response["Body"].read().decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except TARGET_S3.exceptions.NoSuchKey:
        return {}
    except Exception as exc:
        print(f"{spec['satellite']} existing manifest unavailable: {exc}")
        return {}


def native_manifest_key(spec, product):
    return (
        f"{NATIVE_PREFIX}/{spec['prefix']}/"
        f"{product}/manifest.json"
    )


def native_frame_key(spec, product, scan_dt):
    stamp = scan_dt.strftime("%Y%m%dT%H%M00Z")
    render_version = int(
        NATIVE_RENDER_VERSIONS.get(product, 1)
    )
    return (
        f"{NATIVE_PREFIX}/{spec['prefix']}/{product}/"
        f"frames/v{render_version}/{stamp}.webp"
    )


def read_native_manifest(spec, product):
    try:
        response = TARGET_S3.get_object(
            Bucket=TARGET_BUCKET,
            Key=native_manifest_key(spec, product),
        )
        data = json.loads(response["Body"].read().decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except TARGET_S3.exceptions.NoSuchKey:
        return {}
    except Exception as exc:
        print(
            f"{spec['satellite']} {product} manifest unavailable: {exc}"
        )
        return {}


def list_complete_scans(spec, now):
    grouped = {}

    # Include enough hourly folders to backfill the 25-frame loop after a fresh
    # deployment and to bridge UTC day boundaries.
    for hour_offset in range(HISTORY_HOURS + 1):
        hour = now - timedelta(hours=hour_offset)
        prefix = source_hour_prefix(spec, hour)
        paginator = SOURCE_S3.get_paginator("list_objects_v2")

        for page in paginator.paginate(
            Bucket=spec["source_bucket"],
            Prefix=prefix,
        ):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                match = SOURCE_RE.search(key)

                if not match or not key.endswith(".nc"):
                    continue

                scan = match.group("scan")
                channel = match.group("channel")

                group = grouped.setdefault(
                    scan,
                    {
                        "scan": scan,
                        "time": parse_scan(scan),
                        "channels": {},
                    },
                )

                # A late replacement can occasionally coexist with an earlier
                # object. The lexicographically newest key carries the newest
                # creation timestamp in NOAA naming.
                previous = group["channels"].get(channel)
                if previous is None or key > previous:
                    group["channels"][channel] = key

    required_channels = ["01", "02", "03"]

    night_channel = spec.get("night_channel")
    if night_channel:
        required_channels.append(str(night_channel))

    complete = [
        group
        for group in grouped.values()
        if all(
            channel in group["channels"]
            for channel in required_channels
        )
    ]
    complete.sort(key=lambda group: group["time"], reverse=True)
    return complete


def list_complete_native_scans(spec, now):
    grouped = {}

    for hour_offset in range(HISTORY_HOURS + 1):
        hour = now - timedelta(hours=hour_offset)
        prefix = source_hour_prefix(spec, hour)
        paginator = SOURCE_S3.get_paginator("list_objects_v2")

        for page in paginator.paginate(
            Bucket=spec["source_bucket"],
            Prefix=prefix,
        ):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                match = NATIVE_SOURCE_RE.search(key)

                if not match or not key.endswith(".nc"):
                    continue

                scan = match.group("scan")
                channel = match.group("channel")
                group = grouped.setdefault(
                    scan,
                    {
                        "scan": scan,
                        "time": parse_scan(scan),
                        "channels": {},
                    },
                )

                previous = group["channels"].get(channel)
                if previous is None or key > previous:
                    group["channels"][channel] = key

    required = ("02", "05", "08", "10", "12", "13")
    complete = [
        group
        for group in grouped.values()
        if all(
            channel in group["channels"]
            for channel in required
        )
    ]
    complete.sort(key=lambda group: group["time"], reverse=True)
    return complete


def solar_elevation_deg(dt, lat, lon):
    # Compact solar-geometry approximation is sufficient for deciding whether
    # reflected-light imagery can exist somewhere in a broad sector. The final
    # pixel-content test still decides whether a rendered frame is published.
    day = dt.timetuple().tm_yday
    hour = (
        dt.hour
        + dt.minute / 60.0
        + dt.second / 3600.0
    )
    declination = math.radians(
        23.44
        * math.sin(
            2.0
            * math.pi
            * (284.0 + day)
            / 365.0
        )
    )
    hour_angle = math.radians(
        15.0 * (hour + lon / 15.0 - 12.0)
    )
    lat_rad = math.radians(lat)
    sin_elevation = (
        math.sin(lat_rad) * math.sin(declination)
        + math.cos(lat_rad)
        * math.cos(declination)
        * math.cos(hour_angle)
    )
    return math.degrees(
        math.asin(
            max(-1.0, min(1.0, sin_elevation))
        )
    )


def sector_may_have_daylight(dt, spec):
    # Global v8 carries C13 Clean IR on the nighttime side,
    # so every complete Full Disk scan is renderable 24 hours/day.
    if spec.get("night_channel"):
        return True

    anchors = spec.get("daylight_anchors")

    if anchors:
        threshold = float(
            spec.get("daylight_min_elevation", 0.0)
        )

        elevations = [
            solar_elevation_deg(dt, lat, lon)
            for lat, lon in anchors
        ]

        return all(
            elevation > threshold
            for elevation in elevations
        )

    west, south, east, north = spec["bbox"]
    lons = (west, (west + east) / 2.0, east)
    lats = (south, (south + north) / 2.0, north)

    return max(
        solar_elevation_deg(dt, lat, lon)
        for lat in lats
        for lon in lons
    ) > -2.0


def download_source(bucket, key, suffix):
    fd, path = tempfile.mkstemp(
        prefix="zwx-sat-",
        suffix=suffix,
        dir="/tmp",
    )
    os.close(fd)

    try:
        SOURCE_S3.download_file(bucket, key, path)
        return path
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise


def projection_from_dataset(dataset):
    projection = dataset.variables["goes_imager_projection"]

    return CRS.from_proj4(
        " ".join(
            [
                "+proj=geos",
                f"+h={float(projection.perspective_point_height)}",
                f"+lon_0={float(projection.longitude_of_projection_origin)}",
                f"+a={float(projection.semi_major_axis)}",
                f"+b={float(projection.semi_minor_axis)}",
                f"+sweep={str(projection.sweep_angle_axis)}",
                "+units=m",
                "+no_defs",
            ]
        )
    ), float(projection.perspective_point_height)


def source_crs_from_path(path):
    with Dataset(path, "r") as dataset:
        crs, _height = projection_from_dataset(dataset)
    return crs


def read_reflectance(path, gx, gy, stride=1):
    with Dataset(path, "r") as dataset:
        rad = dataset.variables["Rad"]

        x = np.asarray(
            dataset.variables["x"][:],
            dtype=np.float64,
        )
        y = np.asarray(
            dataset.variables["y"][:],
            dtype=np.float64,
        )

        crs, height = projection_from_dataset(dataset)

        x_m = x * height
        y_m = y * height

        finite_geo = np.isfinite(gx) & np.isfinite(gy)

        if not np.any(finite_geo):
            raise RuntimeError(
                "No visible projected points in target satellite sector"
            )

        gx_valid = gx[finite_geo]
        gy_valid = gy[finite_geo]

        min_gx = float(np.min(gx_valid))
        max_gx = float(np.max(gx_valid))
        min_gy = float(np.min(gy_valid))
        max_gy = float(np.max(gy_valid))

        x_hits = np.flatnonzero(
            (x_m >= min_gx) &
            (x_m <= max_gx)
        )
        y_hits = np.flatnonzero(
            (y_m >= min_gy) &
            (y_m <= max_gy)
        )

        if not x_hits.size or not y_hits.size:
            raise RuntimeError(
                "Target sector does not intersect ABI fixed grid"
            )

        # A few source pixels of padding prevent edge rounding from
        # cutting off nearest-neighbor samples.
        margin = max(4, stride * 3)

        x_start = max(
            0,
            int(x_hits[0]) - margin,
        )
        x_stop = min(
            len(x),
            int(x_hits[-1]) + 1 + margin,
        )

        y_start = max(
            0,
            int(y_hits[0]) - margin,
        )
        y_stop = min(
            len(y),
            int(y_hits[-1]) + 1 + margin,
        )

        data = np.asarray(
            np.ma.filled(
                rad[
                    y_start:y_stop:stride,
                    x_start:x_stop:stride,
                ],
                np.nan,
            ),
            dtype=np.float32,
        )

        kappa = float(
            np.asarray(
                dataset.variables["kappa0"][:]
            ).squeeze()
        )

        data *= kappa

        x_crop = x[
            x_start:x_stop:stride
        ]
        y_crop = y[
            y_start:y_stop:stride
        ]

        if len(x_crop) < 2 or len(y_crop) < 2:
            raise RuntimeError(
                "ABI cropped source window is too small"
            )

    return {
        "data": data,
        "x0": float(x_crop[0] * height),
        "dx": float(
            (x_crop[1] - x_crop[0]) * height
        ),
        "y0": float(y_crop[0] * height),
        "dy": float(
            (y_crop[1] - y_crop[0]) * height
        ),
        "crs": crs,
    }


def read_brightness_temperature(path, gx, gy, stride=1):
    with Dataset(path, "r") as dataset:
        rad = dataset.variables["Rad"]

        x = np.asarray(
            dataset.variables["x"][:],
            dtype=np.float64,
        )
        y = np.asarray(
            dataset.variables["y"][:],
            dtype=np.float64,
        )

        crs, height = projection_from_dataset(dataset)

        x_m = x * height
        y_m = y * height

        finite_geo = np.isfinite(gx) & np.isfinite(gy)

        if not np.any(finite_geo):
            raise RuntimeError(
                "No visible projected points in target satellite sector"
            )

        gx_valid = gx[finite_geo]
        gy_valid = gy[finite_geo]

        min_gx = float(np.min(gx_valid))
        max_gx = float(np.max(gx_valid))
        min_gy = float(np.min(gy_valid))
        max_gy = float(np.max(gy_valid))

        x_hits = np.flatnonzero(
            (x_m >= min_gx) &
            (x_m <= max_gx)
        )
        y_hits = np.flatnonzero(
            (y_m >= min_gy) &
            (y_m <= max_gy)
        )

        if not x_hits.size or not y_hits.size:
            raise RuntimeError(
                "Target sector does not intersect ABI fixed grid"
            )

        margin = max(4, stride * 3)

        x_start = max(
            0,
            int(x_hits[0]) - margin,
        )
        x_stop = min(
            len(x),
            int(x_hits[-1]) + 1 + margin,
        )

        y_start = max(
            0,
            int(y_hits[0]) - margin,
        )
        y_stop = min(
            len(y),
            int(y_hits[-1]) + 1 + margin,
        )

        radiance = np.asarray(
            np.ma.filled(
                rad[
                    y_start:y_stop:stride,
                    x_start:x_stop:stride,
                ],
                np.nan,
            ),
            dtype=np.float32,
        )

        fk1 = float(
            np.asarray(
                dataset.variables["planck_fk1"][:]
            ).squeeze()
        )
        fk2 = float(
            np.asarray(
                dataset.variables["planck_fk2"][:]
            ).squeeze()
        )
        bc1 = float(
            np.asarray(
                dataset.variables["planck_bc1"][:]
            ).squeeze()
        )
        bc2 = float(
            np.asarray(
                dataset.variables["planck_bc2"][:]
            ).squeeze()
        )

        data = np.full(
            radiance.shape,
            np.nan,
            dtype=np.float32,
        )

        valid = (
            np.isfinite(radiance) &
            (radiance > 0.0)
        )

        data[valid] = (
            (
                fk2 /
                np.log(
                    fk1 / radiance[valid] + 1.0
                )
            ) -
            bc1
        ) / bc2

        x_crop = x[
            x_start:x_stop:stride
        ]
        y_crop = y[
            y_start:y_stop:stride
        ]

        if len(x_crop) < 2 or len(y_crop) < 2:
            raise RuntimeError(
                "ABI cropped source window is too small"
            )

    return {
        "data": data,
        "x0": float(x_crop[0] * height),
        "dx": float(
            (x_crop[1] - x_crop[0]) * height
        ),
        "y0": float(y_crop[0] * height),
        "dy": float(
            (y_crop[1] - y_crop[0]) * height
        ),
        "crs": crs,
    }



def mercator_bounds(bbox):
    west, south, east, north = bbox
    transformer = Transformer.from_crs(
        "EPSG:4326",
        "EPSG:3857",
        always_xy=True,
    )
    min_x, min_y = transformer.transform(west, south)
    max_x, max_y = transformer.transform(east, north)
    return min_x, min_y, max_x, max_y


def output_width_for_resolution(bbox, resolution_km):
    min_x, _min_y, max_x, _max_y = mercator_bounds(bbox)
    center_lat = (bbox[1] + bbox[3]) / 2.0
    ground_width = (
        (max_x - min_x)
        * math.cos(math.radians(center_lat))
    )
    return max(
        960,
        min(
            3200,
            int(math.ceil(ground_width / (resolution_km * 1000.0))),
        ),
    )


def output_resolution_km(spec):
    configured = spec.get("resolution_km")
    if configured is not None:
        return float(configured)

    bbox = spec["bbox"]
    min_x, _min_y, max_x, _max_y = mercator_bounds(bbox)
    center_lat = (bbox[1] + bbox[3]) / 2.0
    ground_width = (
        (max_x - min_x)
        * math.cos(math.radians(center_lat))
    )
    width = max(960, int(spec.get("output_width", OUTPUT_WIDTH)))
    return round(ground_width / width / 1000.0, 2)


def localized_platform_specs(platform, base_spec):
    specs = []
    for sector_id, bbox in LOCALIZED_SECTORS.get(platform, {}).items():
        spec = dict(base_spec)
        spec.update(
            {
                "prefix": f"{base_spec['prefix']}/sectors/{sector_id}",
                "sector": sector_id,
                "bbox": bbox,
                "output_width": output_width_for_resolution(bbox, 1.0),
                "resolution_km": 1.0,
                "render_version": LOCALIZED_RENDER_VERSION,
                "max_render": LOCALIZED_MAX_RENDER_PER_SECTOR,
                "native_products": False,
                "dehaze_strength": LOCALIZED_DEHAZE_STRENGTH,
            }
        )
        specs.append(spec)
    return specs


def output_grid(spec, source_crs):
    min_x, min_y, max_x, max_y = mercator_bounds(spec["bbox"])
    ratio = (max_x - min_x) / (max_y - min_y)

    width = max(
        960,
        int(spec.get("output_width", OUTPUT_WIDTH)),
    )
    height = max(540, int(round(width / ratio)))

    xs = np.linspace(min_x, max_x, width, dtype=np.float64)
    ys = np.linspace(max_y, min_y, height, dtype=np.float64)
    mx, my = np.meshgrid(xs, ys)

    transformer = Transformer.from_crs(
        "EPSG:3857",
        source_crs,
        always_xy=True,
    )
    gx, gy = transformer.transform(mx, my)

    return gx, gy, width, height


def sample_grid(channel, gx, gy):
    data = channel["data"]
    ix = np.rint((gx - channel["x0"]) / channel["dx"]).astype(np.int64)
    iy = np.rint((gy - channel["y0"]) / channel["dy"]).astype(np.int64)

    valid = (
        np.isfinite(gx)
        & np.isfinite(gy)
        & (ix >= 0)
        & (iy >= 0)
        & (ix < data.shape[1])
        & (iy < data.shape[0])
    )

    output = np.full(gx.shape, np.nan, dtype=np.float32)

    rows, cols = np.nonzero(valid)
    if rows.size:
        sampled = data[iy[rows, cols], ix[rows, cols]]
        output[rows, cols] = sampled

    return output


def truecolor_rgb(blue, red, veggie):
    finite = np.isfinite(blue) & np.isfinite(red) & np.isfinite(veggie)

    blue = np.where(finite, np.clip(blue, 0.0, 1.0), 0.0)
    red = np.where(finite, np.clip(red, 0.0, 1.0), 0.0)
    veggie = np.where(finite, np.clip(veggie, 0.0, 1.0), 0.0)

    # NOAA/CIMSS Natural True Color recipe. ABI has no green visible channel,
    # so C03 (0.86 um "Veggie") supplies the vegetation response missing from
    # C01/C02.
    green = np.clip(
        0.45 * red + 0.10 * veggie + 0.45 * blue,
        0.0,
        1.0,
    )

    rgb = np.stack([red, green, blue], axis=-1)

    span = max(
        0.05,
        TRUECOLOR_WHITE_POINT - TRUECOLOR_BLACK_POINT,
    )

    rgb = np.clip(
        (rgb - TRUECOLOR_BLACK_POINT) / span,
        0.0,
        1.0,
    )

    rgb = np.power(
        rgb,
        1.0 / TRUECOLOR_GAMMA,
    )

    luma = (
        0.2126 * rgb[..., 0]
        + 0.7152 * rgb[..., 1]
        + 0.0722 * rgb[..., 2]
    )

    rgb = (
        luma[..., None]
        + TRUECOLOR_SATURATION
        * (rgb - luma[..., None])
    )

    rgb = np.clip(
        (rgb - 0.5) * TRUECOLOR_CONTRAST + 0.5,
        0.0,
        1.0,
    )

    rgb[~finite] = 0.0

    return rgb, finite


def truecolor_vibrance(rgb, finite):
    """Restore muted surface color after the low-sun brightness lift."""
    luma = (
        0.2126 * rgb[..., 0]
        + 0.7152 * rgb[..., 1]
        + 0.0722 * rgb[..., 2]
    )
    chroma = rgb - luma[..., None]
    color_range = np.max(rgb, axis=-1) - np.min(rgb, axis=-1)

    muted_weight = np.clip(
        1.0 - color_range / 0.35,
        0.0,
        1.0,
    )
    highlight_weight = np.clip(
        (0.92 - luma) / 0.35,
        0.0,
        1.0,
    )
    gain = (
        1.0
        + TRUECOLOR_VIBRANCE
        * muted_weight
        * highlight_weight
    )

    vibrant = np.clip(
        luma[..., None] + gain[..., None] * chroma,
        0.0,
        1.0,
    )
    vibrant[~finite] = 0.0
    return vibrant


def truecolor_limb_dehaze(rgb, finite, spec):
    # Display-only veil reduction, not a physical Rayleigh correction.
    floor = float(np.clip(spec.get("dehaze_floor", 0.0), 0.0, 0.1))
    strength = float(np.clip(spec.get("dehaze_strength", 0.0), 0.0, 0.2))
    if max(floor, strength) <= 0.0:
        return rgb

    bbox = spec["bbox"]
    west, south, east, north = bbox
    height, width = rgb.shape[:2]
    sub_lon = math.radians(
        float(spec.get("subsatellite_longitude", -75.2))
    )

    lons = np.radians(
        np.linspace(west, east, width, dtype=np.float64)
    )
    min_x, min_y, max_x, max_y = mercator_bounds(bbox)
    mercator_y = np.linspace(
        max_y,
        min_y,
        height,
        dtype=np.float64,
    )
    earth_radius = 6378137.0
    lats = (
        2.0 * np.arctan(np.exp(mercator_y / earth_radius))
        - np.pi / 2.0
    )

    view_cosine = (
        np.cos(lats)[:, None]
        * np.cos(lons - sub_lon)[None, :]
    )
    limb = np.clip(
        (0.82 - view_cosine) / 0.32,
        0.0,
        1.0,
    )
    limb = limb * limb * (3.0 - 2.0 * limb)
    veil = floor + max(0.0, strength - floor) * limb

    corrected = np.clip(
        (rgb - veil[..., None])
        / np.maximum(0.8, 1.0 - veil[..., None]),
        0.0,
        1.0,
    )
    corrected[~finite] = 0.0
    return corrected.astype(np.float32, copy=False)


def daylight_fraction(rgb, finite):
    if not np.any(finite):
        return 0.0

    # Reflected-light signal across at least one visible channel. This rejects
    # night scans while allowing partially sunlit dawn/dusk sectors.
    brightness = np.max(rgb, axis=-1)
    lit = finite & (brightness > 0.16)
    return float(np.count_nonzero(lit) / np.count_nonzero(finite))



def night_ir_rgb(bt, finite):
    valid = finite & np.isfinite(bt)

    bt_safe = np.where(
        valid,
        bt,
        298.0,
    )

    # Neutral COD-style nighttime IR:
    # warm land/ocean remains dark charcoal while colder
    # cloud tops brighten strongly toward neutral white.
    cloud = np.clip(
        (298.0 - bt_safe) / 103.0,
        0.0,
        1.0,
    )

    # Lift mid-level clouds without washing out warm surfaces.
    cloud = np.power(
        cloud,
        0.72,
    )

    red = np.clip(
        0.040 + cloud * 0.900,
        0.0,
        1.0,
    )

    green = np.clip(
        0.045 + cloud * 0.930,
        0.0,
        1.0,
    )

    blue = np.clip(
        0.055 + cloud * 0.950,
        0.0,
        1.0,
    )

    rgb = np.stack(
        [red, green, blue],
        axis=-1,
    )

    rgb[~valid] = 0.0

    return rgb, valid


def clean_ir_rgb(bt):
    valid = np.isfinite(bt)
    bt_safe = np.where(valid, bt, 315.0)

    # Independently authored COD-style enhancement: warm gray, colored
    # cold clouds, then dark cores and a white extreme-cold tail.
    # Only the display mapping changes, not measured C13 temperatures.
    temperatures = np.asarray(
        [
            180.0,
            193.0,
            200.0,
            210.0,
            213.0,
            218.0,
            226.0,
            230.0,
            235.0,
            240.0,
            245.0,
            253.0,
            258.0,
            280.0,
            285.0,
            300.0,
            315.0,
        ],
        dtype=np.float32,
    )

    colors = np.asarray(
        [
            [1.00, 1.00, 1.00],  # extreme-cold tail
            [0.00, 0.00, 0.00],  # dark cold core
            [1.00, 0.00, 0.00],  # red
            [1.00, 0.45, 0.00],  # orange
            [1.00, 1.00, 0.00],  # yellow
            [0.75, 1.00, 0.00],
            [0.00, 1.00, 0.00],  # green
            [0.00, 0.90, 0.15],
            [0.00, 0.25, 1.00],  # blue
            [0.60, 0.00, 1.00],  # purple
            [1.00, 1.00, 1.00],  # ordinary cold cloud
            [0.93, 0.93, 0.93],
            [0.85, 0.85, 0.85],
            [0.30, 0.30, 0.30],
            [0.20, 0.20, 0.20],
            [0.00, 0.00, 0.00],
            [0.00, 0.00, 0.00],  # warm surface
        ],
        dtype=np.float32,
    )

    rgb = np.empty(
        bt_safe.shape + (3,),
        dtype=np.float32,
    )

    for channel in range(3):
        rgb[..., channel] = np.interp(
            bt_safe,
            temperatures,
            colors[:, channel],
        )

    rgb[~valid] = 0.0
    return rgb, valid


def _normalize_rgb_channel(values, low, high):
    return np.clip(
        (values - low) / (high - low),
        0.0,
        1.0,
    )


def air_mass_rgb(bt08, bt10, bt12, bt13):
    valid = (
        np.isfinite(bt08)
        & np.isfinite(bt10)
        & np.isfinite(bt12)
        & np.isfinite(bt13)
    )

    c08 = np.where(valid, bt08, 250.0)
    c10 = np.where(valid, bt10, 250.0)
    c12 = np.where(valid, bt12, 250.0)
    c13 = np.where(valid, bt13, 250.0)

    # Standard GOES-R Air Mass RGB recipe.
    red = _normalize_rgb_channel(c08 - c10, -26.2, 0.6)
    green = _normalize_rgb_channel(c12 - c13, -42.2, 6.7)
    blue = 1.0 - _normalize_rgb_channel(
        c08 - 273.15,
        -64.65,
        -29.25,
    )

    rgb = np.stack([red, green, blue], axis=-1)
    rgb[~valid] = 0.0
    return rgb, valid


def simple_water_vapor_rgb(bt08, bt10, bt13):
    valid = np.isfinite(bt08) & np.isfinite(bt10) & np.isfinite(bt13)
    c08 = np.where(valid, bt08, 250.0)
    c10 = np.where(valid, bt10, 250.0)
    c13 = np.where(valid, bt13, 250.0)

    red = _normalize_rgb_channel(c13, 278.96, 202.29)
    green = _normalize_rgb_channel(c08, 242.67, 214.66)
    blue = _normalize_rgb_channel(c10, 261.03, 245.12)
    red = np.power(red, 1.0 / 10.0)
    green = np.power(green, 1.0 / 5.5)
    blue = np.power(blue, 1.0 / 5.5)

    rgb = np.stack([red, green, blue], axis=-1)
    rgb[~valid] = 0.0
    return rgb, valid


def day_cloud_phase_rgb(bt13, reflectance02, reflectance05):
    valid = (
        np.isfinite(bt13)
        & np.isfinite(reflectance02)
        & np.isfinite(reflectance05)
    )
    c13 = np.where(valid, bt13, 250.0)
    c02 = np.where(valid, reflectance02, 0.0)
    c05 = np.where(valid, reflectance05, 0.0)

    red = _normalize_rgb_channel(c13, 280.67, 219.62)
    green = _normalize_rgb_channel(c02, 0.0, 0.78)
    blue = _normalize_rgb_channel(c05, 0.01, 0.59)

    rgb = np.stack([red, green, blue], axis=-1)
    rgb[~valid] = 0.0
    return rgb, valid


def solar_daylight_alpha(
    dt,
    bbox,
    width,
    height,
    feather_degrees=TRUECOLOR_TERMINATOR_FEATHER_DEGREES,
):
    west, south, east, north = bbox

    min_x, min_y, max_x, max_y = mercator_bounds(
        bbox
    )

    lons = np.linspace(
        west,
        east,
        width,
        dtype=np.float64,
    )

    mercator_y = np.linspace(
        max_y,
        min_y,
        height,
        dtype=np.float64,
    )

    earth_radius = 6378137.0

    lats = np.degrees(
        2.0 *
        np.arctan(
            np.exp(
                mercator_y /
                earth_radius
            )
        ) -
        np.pi / 2.0
    )

    day = dt.timetuple().tm_yday

    hour = (
        dt.hour +
        dt.minute / 60.0 +
        dt.second / 3600.0
    )

    declination = np.radians(
        23.44 *
        np.sin(
            2.0 *
            np.pi *
            (284.0 + day) /
            365.0
        )
    )

    hour_angle = np.radians(
        15.0 *
        (
            hour +
            lons / 15.0 -
            12.0
        )
    )

    lat_rad = np.radians(lats)

    sin_elevation = (
        np.sin(lat_rad)[:, None] *
        np.sin(declination)
        +
        np.cos(lat_rad)[:, None] *
        np.cos(declination) *
        np.cos(hour_angle)[None, :]
    )

    feather = math.sin(
        math.radians(
            feather_degrees
        )
    )
    cutoff = math.sin(
        math.radians(
            TRUECOLOR_DAYLIGHT_CUTOFF_DEGREES
        )
    )

    alpha = np.clip(
        (
            sin_elevation -
            cutoff +
            feather
        ) /
        (
            2.0 *
            feather
        ),
        0.0,
        1.0,
    )

    # Smoothstep only inside the narrow anti-aliasing band.
    alpha = (
        alpha *
        alpha *
        (
            3.0 -
            2.0 *
            alpha
        )
    )

    return alpha.astype(
        np.float32,
        copy=False,
    )


def solar_reflectance_gain(
    dt,
    bbox,
    width,
    height,
):
    """Illumination correction for low-sun reflected-light imagery.

    ABI visible reflectance naturally darkens toward the terminator.
    Reach a capped correction before the terminator and hold it through
    the day/IR cutoff so the boundary stays crisp without a bright halo.
    """
    west, south, east, north = bbox
    min_x, min_y, max_x, max_y = mercator_bounds(bbox)

    lons = np.linspace(
        west,
        east,
        width,
        dtype=np.float64,
    )
    mercator_y = np.linspace(
        max_y,
        min_y,
        height,
        dtype=np.float64,
    )

    earth_radius = 6378137.0
    lats = np.degrees(
        2.0 *
        np.arctan(
            np.exp(
                mercator_y /
                earth_radius
            )
        ) -
        np.pi / 2.0
    )

    day = dt.timetuple().tm_yday
    hour = (
        dt.hour +
        dt.minute / 60.0 +
        dt.second / 3600.0
    )

    declination = np.radians(
        23.44 *
        np.sin(
            2.0 *
            np.pi *
            (284.0 + day) /
            365.0
        )
    )
    hour_angle = np.radians(
        15.0 *
        (
            hour +
            lons / 15.0 -
            12.0
        )
    )
    lat_rad = np.radians(lats)

    sin_elevation = (
        np.sin(lat_rad)[:, None] *
        np.sin(declination)
        +
        np.cos(lat_rad)[:, None] *
        np.cos(declination) *
        np.cos(hour_angle)[None, :]
    )

    lift_start = math.sin(
        math.radians(TRUECOLOR_LOW_SUN_START_DEGREES)
    )
    lift_plateau = math.sin(
        math.radians(TRUECOLOR_LOW_SUN_PLATEAU_DEGREES)
    )
    low_sun = np.clip(
        (lift_start - sin_elevation) /
        max(lift_start - lift_plateau, 1e-6),
        0.0,
        1.0,
    )
    low_sun = (
        low_sun *
        low_sun *
        (
            3.0 -
            2.0 *
            low_sun
        )
    )

    return (
        1.0 +
        (TRUECOLOR_LOW_SUN_REFLECTANCE_GAIN - 1.0) *
        low_sun
    ).astype(
        np.float32,
        copy=False,
    )


def correct_low_sun_reflectance(channel, gain):
    """Lift dim reflectance while rolling off naturally at highlights."""
    clipped = np.clip(channel, 0.0, 1.0)
    corrected = (
        clipped * gain /
        (1.0 + clipped * (gain - 1.0))
    )
    return np.where(np.isfinite(channel), corrected, np.nan).astype(
        np.float32,
        copy=False,
    )



def encode_webp(rgb, finite):
    color = np.rint(
        np.clip(rgb, 0.0, 1.0) * 255.0
    ).astype(np.uint8)

    alpha = np.where(
        finite,
        255,
        0,
    ).astype(np.uint8)

    image = Image.fromarray(
        np.dstack([color, alpha]),
        mode="RGBA",
    )

    output = io.BytesIO()
    image.save(
        output,
        format="WEBP",
        quality=WEBP_QUALITY,
        method=4,
    )
    return output.getvalue(), image.width, image.height


def render_scan(spec, group, source_cache=None):
    paths = {}
    owned_paths = source_cache is None
    if source_cache is None:
        source_cache = {}

    try:
        channels = ["01", "02", "03"]

        night_channel = spec.get("night_channel")
        if night_channel:
            channels.append(str(night_channel))

        for channel in channels:
            cache_key = (
                spec["source_bucket"],
                group["channels"][channel],
            )
            path = source_cache.get(cache_key)
            if not path or not os.path.exists(path):
                path = download_source(
                    spec["source_bucket"],
                    group["channels"][channel],
                    f"-C{channel}.nc",
                )
                source_cache[cache_key] = path
            paths[channel] = path

        source_crs = source_crs_from_path(
            paths["01"]
        )

        gx, gy, width, height = output_grid(
            spec,
            source_crs,
        )

        blue = read_reflectance(
            paths["01"],
            gx,
            gy,
            stride=1,
        )

        red = read_reflectance(
            paths["02"],
            gx,
            gy,
            stride=int(spec.get("c02_stride", 2)),
        )

        veggie = read_reflectance(
            paths["03"],
            gx,
            gy,
            stride=1,
        )

        blue_out = sample_grid(
            blue,
            gx,
            gy,
        )
        red_out = sample_grid(
            red,
            gx,
            gy,
        )
        veggie_out = sample_grid(
            veggie,
            gx,
            gy,
        )

        reflectance_gain = solar_reflectance_gain(
            group["time"],
            spec["bbox"],
            width,
            height,
        )
        blue_out = correct_low_sun_reflectance(
            blue_out,
            reflectance_gain,
        )
        red_out = correct_low_sun_reflectance(
            red_out,
            reflectance_gain,
        )
        veggie_out = correct_low_sun_reflectance(
            veggie_out,
            reflectance_gain,
        )

        day_rgb, day_finite = truecolor_rgb(
            blue_out,
            red_out,
            veggie_out,
        )
        day_rgb = truecolor_limb_dehaze(
            day_rgb,
            day_finite,
            spec,
        )
        day_rgb = truecolor_vibrance(
            day_rgb,
            day_finite,
        )

        fraction = daylight_fraction(
            day_rgb,
            day_finite,
        )

        if night_channel:
            night = read_brightness_temperature(
                paths[str(night_channel)],
                gx,
                gy,
                stride=1,
            )

            bt_out = sample_grid(
                night,
                gx,
                gy,
            )

            night_rgb, night_finite = night_ir_rgb(
                bt_out,
                np.isfinite(bt_out),
            )

            alpha = solar_daylight_alpha(
                group["time"],
                spec["bbox"],
                width,
                height,
            )

            # Never expose invalid reflected-light pixels over
            # valid infrared data.
            day_weight = (
                alpha *
                day_finite.astype(
                    np.float32
                )
            )

            rgb = (
                day_rgb *
                day_weight[..., None]
                +
                night_rgb *
                (
                    1.0 -
                    day_weight[..., None]
                )
            )

            finite = (
                day_finite |
                night_finite
            )

            rgb[~finite] = 0.0

        else:
            if fraction < MIN_DAYLIGHT_FRACTION:
                print(
                    f"{spec['satellite']} {group['scan']} skipped: "
                    f"daylightFraction={fraction:.3f}"
                )
                return None

            rgb = day_rgb
            finite = day_finite

        payload, width, height = encode_webp(
            rgb,
            finite,
        )

        key = frame_key(
            spec,
            group["time"],
        )

        TARGET_S3.put_object(
            Bucket=TARGET_BUCKET,
            Key=key,
            Body=payload,
            ContentType="image/webp",
            CacheControl=(
                "public,max-age=31536000,immutable"
            ),
        )

        print(
            f"{spec['satellite']} published {group['scan']} "
            f"{width}x{height} daylightFraction={fraction:.3f} "
            f"dayNight={bool(night_channel)} "
            f"bytes={len(payload)}"
        )

        return {
            "time": iso_z(
                group["time"]
            ),
            "path": key[
                len(TARGET_PREFIX) + 1 :
            ],
            "width": width,
            "height": height,
            "daylightFraction": round(
                fraction,
                4,
            ),
            "dayNightComposite": bool(
                night_channel
            ),
            "scan": group["scan"],
        }

    finally:
        if owned_paths:
            for path in paths.values():
                try:
                    os.unlink(path)
                except OSError:
                    pass


def native_output_strips(spec, source_crs, rows=256):
    min_x, min_y, max_x, max_y = mercator_bounds(spec["bbox"])
    ratio = (max_x - min_x) / (max_y - min_y)
    width = max(960, int(spec.get("output_width", OUTPUT_WIDTH)))
    height = max(540, int(round(width / ratio)))
    xs = np.linspace(min_x, max_x, width, dtype=np.float64)
    ys = np.linspace(max_y, min_y, height, dtype=np.float64)
    transformer = Transformer.from_crs("EPSG:3857", source_crs, always_xy=True)
    for row in range(0, height, rows):
        stop = min(height, row + rows)
        mx, my = np.meshgrid(xs, ys[row:stop])
        gx, gy = transformer.transform(mx, my)
        south = math.degrees(2 * math.atan(math.exp(ys[stop - 1] / 6378137)) - math.pi / 2)
        north = math.degrees(2 * math.atan(math.exp(ys[row] / 6378137)) - math.pi / 2)
        strip_bbox = (spec["bbox"][0], south, spec["bbox"][2], north)
        yield row, gx, gy, strip_bbox, width, height


def native_product_rgb(product, sampled, time, bbox, width, height):
    if product == "clean-ir":
        return clean_ir_rgb(sampled["13"])
    if product == "air-mass":
        return air_mass_rgb(sampled["08"], sampled["10"], sampled["12"], sampled["13"])
    if product == "simple-water-vapor":
        return simple_water_vapor_rgb(sampled["08"], sampled["10"], sampled["13"])
    rgb, valid = day_cloud_phase_rgb(sampled["13"], sampled["02"], sampled["05"])
    valid &= solar_daylight_alpha(time, bbox, width, height) >= 0.5
    rgb[~valid] = 0.0
    return rgb, valid


def encode_native_rgba(rgba):
    image = Image.fromarray(rgba, mode="RGBA")
    output = io.BytesIO()
    image.save(output, format="WEBP", quality=WEBP_QUALITY, method=4)
    return output.getvalue(), image.width, image.height


def render_native_scan(spec, group):
    paths = {}
    channels = ("02", "05", "08", "10", "12", "13")

    try:
        for channel in channels:
            paths[channel] = download_source(
                spec["source_bucket"],
                group["channels"][channel],
                f"-C{channel}.nc",
            )

        source_crs = source_crs_from_path(paths["13"])
        # Preserve native IR detail for client-side localized crops without
        # changing the True Color renderer or allocating a larger Full Disk.
        native_spec = dict(spec)
        if spec.get("sector") != "GLOBAL":
            native_spec["output_width"] = max(
                int(spec.get("output_width", OUTPUT_WIDTH)),
                NATIVE_REGIONAL_WIDTH,
            )
        products = ("clean-ir", "air-mass", "simple-water-vapor", "day-cloud-phase")
        images = {}
        day_cloud_visible = False
        native_visible = False
        # Keep full-frame storage in uint8; projection, sampling and RGB
        # intermediates are bounded to one strip rather than four full images.
        for row, gx, gy, strip_bbox, width, height in native_output_strips(native_spec, source_crs):
            if not images:
                images = {product: np.zeros((height, width, 4), dtype=np.uint8) for product in products}
            if not np.any(np.isfinite(gx) & np.isfinite(gy)):
                continue
            sampled = {}
            for channel in channels:
                reader = read_reflectance if channel in ("02", "05") else read_brightness_temperature
                try:
                    source = reader(paths[channel], gx, gy, stride=1)
                except RuntimeError as error:
                    if str(error) != "Target sector does not intersect ABI fixed grid":
                        raise
                    sampled[channel] = np.full(gx.shape, np.nan, dtype=np.float32)
                else:
                    sampled[channel] = sample_grid(source, gx, gy)
                    del source
            for product in products:
                rgb, finite = native_product_rgb(product, sampled, group["time"], strip_bbox, width, gx.shape[0])
                native_visible |= bool(np.any(finite))
                if product == "day-cloud-phase":
                    day_cloud_visible |= bool(np.any(finite))
                strip = images[product][row:row + gx.shape[0]]
                strip[..., :3] = np.rint(np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
                strip[..., 3] = np.where(finite, 255, 0).astype(np.uint8)
                del rgb, finite
            del sampled
        if not native_visible:
            raise RuntimeError("No visible projected points in target satellite sector")
        if not day_cloud_visible:
            del images["day-cloud-phase"]
        frames = {}

        for product in tuple(images):
            rgba = images.pop(product)
            payload, image_width, image_height = encode_native_rgba(rgba)
            del rgba
            key = native_frame_key(spec, product, group["time"])
            TARGET_S3.put_object(
                Bucket=TARGET_BUCKET,
                Key=key,
                Body=payload,
                ContentType="image/webp",
                CacheControl="public,max-age=31536000,immutable",
            )
            frames[product] = {
                "time": iso_z(group["time"]),
                "path": key[len(NATIVE_PREFIX) + 1 :],
                "width": image_width,
                "height": image_height,
                "scan": group["scan"],
            }

        print(
            f"{spec['satellite']} native {group['scan']} "
            f"{width}x{height} products={'+'.join(frames)}"
        )
        return frames

    finally:
        for path in paths.values():
            try:
                os.unlink(path)
            except OSError:
                pass


def publish_manifest(spec, existing, frames, checked_scans, now):
    cadence_minutes = int(
        spec.get("cadence_minutes", 5)
    )
    frame_count = int(
        spec.get("frame_count", FRAME_COUNT)
    )

    frames_by_scan = {
        frame["scan"]: frame
        for frame in frames
        if isinstance(frame, dict) and frame.get("scan")
    }
    all_ordered = sorted(
        frames_by_scan.values(),
        key=lambda frame: frame["time"],
    )

    # Publish only the newest contiguous daylight run.
    # Never bridge sunset/night/sunrise with old daylight imagery.
    contiguous = []
    if all_ordered:
        contiguous.append(all_ordered[-1])
        newer_time = datetime.fromisoformat(
            all_ordered[-1]["time"].replace("Z", "+00:00")
        )

        for frame in reversed(all_ordered[:-1]):
            frame_time = datetime.fromisoformat(
                frame["time"].replace("Z", "+00:00")
            )
            gap = newer_time - frame_time

            # Allow a small timestamp tolerance beyond the nominal
            # cadence without accepting a genuine missing/nighttime gap.
            if gap > timedelta(
                minutes=cadence_minutes + 2
            ):
                break

            contiguous.append(frame)
            newer_time = frame_time

    ordered = list(reversed(contiguous))[-frame_count:]

    output = {
        "version": 1,
        "renderVersion": int(
            spec.get("render_version", RENDER_VERSION)
        ),
        "generated": iso_z(now),
        "platform": spec["platform"],
        "satellite": spec["satellite"],
        "sector": spec["sector"],
        "product": (
            "Natural True Color / C13 Night IR"
            if spec.get("night_channel")
            else "CIMSS Natural True Color"
        ),
        "sourceProduct": (
            f"{spec['source_product']} "
            + (
                "C01+C02+C03+C13"
                if spec.get("night_channel")
                else "C01+C02+C03"
            )
        ),
        "cadenceMinutes": cadence_minutes,
        "frameCount": len(ordered),
        "targetFrameCount": frame_count,
        "daytimeOnly": not bool(
            spec.get("night_channel")
        ),
        "dayNightComposite": bool(
            spec.get("night_channel")
        ),
        "nightChannel": (
            f"C{spec['night_channel']}"
            if spec.get("night_channel")
            else None
        ),
        "bbox": list(spec["bbox"]),
        "recipe": {
            "red": "C02 0.64um",
            "green": "0.45*C02 + 0.10*C03 + 0.45*C01",
            "blue": "C01 0.47um",
            "gamma": TRUECOLOR_GAMMA,
            "blackPoint": TRUECOLOR_BLACK_POINT,
            "whitePoint": TRUECOLOR_WHITE_POINT,
            "saturation": TRUECOLOR_SATURATION,
            "contrast": TRUECOLOR_CONTRAST,
            "vibrance": TRUECOLOR_VIBRANCE,
            "displayDehazeFloor": float(spec.get("dehaze_floor", 0.0)),
            "lowSunReflectanceGain": TRUECOLOR_LOW_SUN_REFLECTANCE_GAIN,
            "lowSunStartDegrees": TRUECOLOR_LOW_SUN_START_DEGREES,
            "lowSunPlateauDegrees": TRUECOLOR_LOW_SUN_PLATEAU_DEGREES,
            "transparentNoData": True,
            "resolutionKm": output_resolution_km(spec),
            "limbDehaze": float(spec.get("dehaze_strength", 0.0)),
            "night": (
                "C13 Clean Longwave IR"
                if spec.get("night_channel")
                else None
            ),
            "terminatorFeatherDegrees": (
                TRUECOLOR_TERMINATOR_FEATHER_DEGREES
                if spec.get("night_channel")
                else None
            ),
            "daylightCutoffDegrees": (
                TRUECOLOR_DAYLIGHT_CUTOFF_DEGREES
                if spec.get("night_channel")
                else None
            ),
        },
        "checkedScans": checked_scans[-160:],
        "frames": ordered,
    }

    TARGET_S3.put_object(
        Bucket=TARGET_BUCKET,
        Key=manifest_key(spec),
        Body=json.dumps(
            output,
            separators=(",", ":"),
        ).encode("utf-8"),
        ContentType="application/json",
        CacheControl="public,max-age=20,stale-while-revalidate=60",
    )

    return output


def process_platform(
    platform,
    spec,
    now,
    candidates=None,
    source_cache=None,
):
    existing = read_manifest(spec)

    render_version = int(
        spec.get("render_version", RENDER_VERSION)
    )

    if existing.get("renderVersion") != render_version:
        if existing:
            print(
                f"{spec['satellite']} resetting manifest for "
                f"renderVersion={render_version}"
            )
        existing = {}

    frames = [
        frame
        for frame in existing.get("frames", [])
        if isinstance(frame, dict) and frame.get("scan")
    ]
    checked = [
        str(scan)
        for scan in existing.get("checkedScans", [])
        if scan
    ]
    checked_set = set(checked)

    if candidates is None:
        candidates = list_complete_scans(spec, now)

    # Once a platform already has imagery, backfill only within roughly one
    # complete 25-frame loop. This prevents routine runs from crossing an
    # overnight gap and wasting compute rendering the previous daylight period.
    candidate_floor = None
    if frames:
        newest_existing = max(
            datetime.fromisoformat(
                frame["time"].replace("Z", "+00:00")
            )
            for frame in frames
        )
        cadence_minutes = int(
            spec.get("cadence_minutes", 5)
        )
        frame_count = int(
            spec.get("frame_count", FRAME_COUNT)
        )

        candidate_floor = newest_existing - timedelta(
            minutes=(
                frame_count * cadence_minutes
            ) + (cadence_minutes * 2)
        )

    rendered = 0
    skipped = 0
    attempted = 0

    # Walk backward through fresh scans until the render budget is used.
    # Obvious nighttime scans are marked checked without downloading ~three
    # ABI files apiece, so a fresh deployment can immediately backfill the
    # most recent daylight loop even when deployed after sunset.
    for group in candidates:
        if (
            candidate_floor is not None
            and group["time"] < candidate_floor
        ):
            break

        if group["scan"] in checked_set:
            continue

        if not sector_may_have_daylight(
            group["time"],
            spec,
        ):
            checked.append(group["scan"])
            checked_set.add(group["scan"])
            skipped += 1
            continue

        if attempted >= int(
            spec.get(
                "max_render",
                MAX_RENDER_PER_PLATFORM,
            )
        ):
            break

        attempted += 1

        try:
            frame = render_scan(
                spec,
                group,
                source_cache=source_cache,
            )
            checked.append(group["scan"])
            checked_set.add(group["scan"])

            if frame:
                frames.append(frame)
                rendered += 1
            else:
                skipped += 1
        except Exception as exc:
            # Do not mark a failed scan as checked; a later invocation should
            # retry transient S3/download/decode failures.
            print(
                f"{spec['satellite']} {group['scan']} failed: {exc}"
            )

    manifest = publish_manifest(
        spec,
        existing,
        frames,
        checked,
        now,
    )

    return {
        "platform": platform,
        "satellite": spec["satellite"],
        "candidates": len(candidates),
        "attempted": attempted,
        "rendered": rendered,
        "skippedNight": skipped,
        "frameCount": manifest["frameCount"],
        "latestTime": (
            manifest["frames"][-1]["time"]
            if manifest["frames"]
            else None
        ),
    }


def publish_native_manifest(spec, product, frames, checked_scans, now):
    cadence_minutes = int(spec.get("cadence_minutes", 5))
    frame_count = int(spec.get("frame_count", FRAME_COUNT))

    frames_by_scan = {
        frame["scan"]: frame
        for frame in frames
        if isinstance(frame, dict) and frame.get("scan")
    }
    all_ordered = sorted(
        frames_by_scan.values(),
        key=lambda frame: frame["time"],
    )

    contiguous = []
    if all_ordered:
        contiguous.append(all_ordered[-1])
        newer_time = datetime.fromisoformat(
            all_ordered[-1]["time"].replace("Z", "+00:00")
        )
        for frame in reversed(all_ordered[:-1]):
            frame_time = datetime.fromisoformat(
                frame["time"].replace("Z", "+00:00")
            )
            if newer_time - frame_time > timedelta(
                minutes=cadence_minutes + 2
            ):
                break
            contiguous.append(frame)
            newer_time = frame_time

    ordered = list(reversed(contiguous))[-frame_count:]

    product_metadata = {
        "clean-ir": (
            "Clean IR",
            "C13",
            {
                "channel": "C13 10.3um Clean Longwave IR",
                "palette": CLEAN_IR_PALETTE_ID,
                "coldCloudEnhancement": (
                    "white-purple-blue-green-yellow-orange-red-black-white"
                ),
                "transparentNoData": True,
            },
        ),
        "air-mass": (
            "Air Mass RGB",
            "C08+C10+C12+C13",
            {
                "red": "C08-C10 (-26.2 to 0.6 K)",
                "green": "C12-C13 (-42.2 to 6.7 K)",
                "blue": "C08 BT (-64.65 to -29.25 C), inverted",
                "transparentNoData": True,
            },
        ),
        "simple-water-vapor": (
            "Simple Water Vapor RGB",
            "C08+C10+C13",
            {
                "red": "C13 BT (278.96 to 202.29 K), gamma 10",
                "green": "C08 BT (242.67 to 214.66 K), gamma 5.5",
                "blue": "C10 BT (261.03 to 245.12 K), gamma 5.5",
                "transparentNoData": True,
            },
        ),
        "day-cloud-phase": (
            "Day Cloud Phase RGB",
            "C02+C05+C13",
            {
                "red": "C13 BT (280.67 to 219.62 K), inverted",
                "green": "C02 reflectance (0 to 78 percent)",
                "blue": "C05 reflectance (1 to 59 percent)",
                "daylightOnly": True,
                "transparentNoData": True,
            },
        ),
    }
    product_name, source_channels, recipe = product_metadata[product]

    output = {
        "version": 1,
        "renderVersion": int(
            NATIVE_RENDER_VERSIONS.get(product, 1)
        ),
        "generated": iso_z(now),
        "platform": spec["platform"],
        "satellite": spec["satellite"],
        "sector": spec["sector"],
        "product": product_name,
        "sourceProduct": f"{spec['source_product']} {source_channels}",
        "cadenceMinutes": cadence_minutes,
        "frameCount": len(ordered),
        "targetFrameCount": frame_count,
        "nativeProduct": True,
        "bbox": list(spec["bbox"]),
        "recipe": recipe,
        "checkedScans": checked_scans[-160:],
        "frames": ordered,
    }

    TARGET_S3.put_object(
        Bucket=TARGET_BUCKET,
        Key=native_manifest_key(spec, product),
        Body=json.dumps(output, separators=(",", ":")).encode("utf-8"),
        ContentType="application/json",
        CacheControl="public,max-age=20,stale-while-revalidate=60",
    )
    return output


def process_native_platform(platform, spec, now):
    products = (
        "clean-ir",
        "air-mass",
        "simple-water-vapor",
        "day-cloud-phase",
    )
    existing = {
        product: read_native_manifest(spec, product)
        for product in products
    }

    for product in products:
        expected_version = int(
            NATIVE_RENDER_VERSIONS.get(product, 1)
        )
        if (
            existing[product]
            and existing[product].get("renderVersion")
            != expected_version
        ):
            print(
                f"{spec['satellite']} {product} resetting "
                f"manifest for renderVersion={expected_version}"
            )
            existing[product] = {}

    frames = {
        product: [
            frame
            for frame in existing[product].get("frames", [])
            if isinstance(frame, dict) and frame.get("scan")
        ]
        for product in products
    }

    checked_lists = [
        [
            str(scan)
            for scan in existing[product].get("checkedScans", [])
            if scan
        ]
        for product in products
    ]
    checked_others = [set(scans) for scans in checked_lists[1:]]
    checked = [
        scan
        for scan in checked_lists[0]
        if all(scan in scans for scans in checked_others)
    ]
    checked_set = set(checked)

    candidates = list_complete_native_scans(spec, now)

    candidate_floor = None
    shared_frames = frames["clean-ir"]
    if shared_frames:
        newest_existing = max(
            datetime.fromisoformat(
                frame["time"].replace("Z", "+00:00")
            )
            for frame in shared_frames
        )
        cadence_minutes = int(spec.get("cadence_minutes", 5))
        frame_count = int(spec.get("frame_count", FRAME_COUNT))
        candidate_floor = newest_existing - timedelta(
            minutes=(frame_count * cadence_minutes) + (cadence_minutes * 2)
        )

    attempted = 0
    rendered = 0
    max_render = int(spec.get("native_max_render", 1))

    for group in candidates:
        if candidate_floor is not None and group["time"] < candidate_floor:
            break
        if group["scan"] in checked_set:
            continue
        if attempted >= max_render:
            break

        attempted += 1
        try:
            rendered_frames = render_native_scan(spec, group)
            for product in products:
                frame = rendered_frames.get(product)
                if frame:
                    frames[product].append(frame)
            checked.append(group["scan"])
            checked_set.add(group["scan"])
            rendered += 1
        except Exception as exc:
            print(
                f"{spec['satellite']} native {group['scan']} failed: {exc}"
            )

    manifests = {
        product: publish_native_manifest(
            spec,
            product,
            frames[product],
            checked,
            now,
        )
        for product in products
    }

    return {
        "platform": platform,
        "attempted": attempted,
        "rendered": rendered,
        "cleanIrFrames": manifests["clean-ir"]["frameCount"],
        "airMassFrames": manifests["air-mass"]["frameCount"],
        "simpleWaterVaporFrames": manifests[
            "simple-water-vapor"
        ]["frameCount"],
        "dayCloudPhaseFrames": manifests[
            "day-cloud-phase"
        ]["frameCount"],
        "latestTime": (
            manifests["clean-ir"]["frames"][-1]["time"]
            if manifests["clean-ir"]["frames"]
            else None
        ),
    }


def lambda_handler(event, context):
    now = utcnow()
    results = []

    for platform, spec in PLATFORMS.items():
        candidates = list_complete_scans(spec, now)
        source_cache = {}
        localized_results = []

        try:
            result = process_platform(
                platform,
                spec,
                now,
                candidates=candidates,
                source_cache=source_cache,
            )

            if PUBLISH_MODE != "global":
                for localized_spec in localized_platform_specs(
                    platform,
                    spec,
                ):
                    localized_results.append(
                        process_platform(
                            platform,
                            localized_spec,
                            now,
                            candidates=candidates,
                            source_cache=source_cache,
                        )
                    )
        finally:
            for path in set(source_cache.values()):
                try:
                    os.unlink(path)
                except OSError:
                    pass

        if localized_results:
            result["localized"] = localized_results
        if spec.get("native_products"):
            result["native"] = process_native_platform(
                platform,
                spec,
                now,
            )
        results.append(result)

    print(json.dumps(results, separators=(",", ":")))

    return {
        "statusCode": 200,
        "generated": iso_z(now),
        "results": results,
    }
