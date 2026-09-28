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

FRAME_COUNT = int(os.getenv("SATELLITE_TRUECOLOR_FRAME_COUNT", "25"))
MAX_RENDER_PER_PLATFORM = int(
    os.getenv("SATELLITE_TRUECOLOR_MAX_RENDER_PER_PLATFORM", "2")
)
OUTPUT_WIDTH = int(os.getenv("SATELLITE_TRUECOLOR_WIDTH", "2200"))
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
    os.getenv("SATELLITE_TRUECOLOR_WHITE_POINT", "0.80")
)
TRUECOLOR_GAMMA = float(
    os.getenv("SATELLITE_TRUECOLOR_GAMMA", "2.2")
)
TRUECOLOR_SATURATION = float(
    os.getenv("SATELLITE_TRUECOLOR_SATURATION", "1.06")
)
TRUECOLOR_CONTRAST = float(
    os.getenv("SATELLITE_TRUECOLOR_CONTRAST", "1.03")
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
        "render_version": RENDER_VERSION,

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
        "render_version": RENDER_VERSION,
        "bbox": (-134.0, 20.0, -101.0, 53.0),
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
        "render_version": 11,
        "night_channel": "13",
        "low_cloud_channel": "07",

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
        "render_version": 11,
        "night_channel": "13",
        "low_cloud_channel": "07",

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
    r"-M\dC(?P<channel>01|02|03|07|13)_G\d+_s(?P<scan>\d{11})"
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

    low_cloud_channel = spec.get("low_cloud_channel")
    if low_cloud_channel:
        required_channels.append(str(low_cloud_channel))

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


def output_grid(spec, source_crs):
    min_x, min_y, max_x, max_y = mercator_bounds(spec["bbox"])
    ratio = (max_x - min_x) / (max_y - min_y)

    width = max(960, OUTPUT_WIDTH)
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


def daylight_fraction(rgb, finite):
    if not np.any(finite):
        return 0.0

    # Reflected-light signal across at least one visible channel. This rejects
    # night scans while allowing partially sunlit dawn/dusk sectors.
    brightness = np.max(rgb, axis=-1)
    lit = finite & (brightness > 0.16)
    return float(np.count_nonzero(lit) / np.count_nonzero(finite))



def night_ir_rgb(
    bt,
    finite,
    low_cloud_btd=None,
):
    valid = (
        finite &
        np.isfinite(bt)
    )

    bt_safe = np.where(
        valid,
        bt,
        305.0,
    )

    # --------------------------------------------------------
    # C13 thermal base.
    #
    # Keep clear land/ocean visible instead of crushing all
    # warm pixels to black. Colder clouds progressively
    # brighten toward white.
    # --------------------------------------------------------

    thermal = np.clip(
        (305.0 - bt_safe) / 115.0,
        0.0,
        1.0,
    )

    thermal = np.power(
        thermal,
        0.72,
    )

    red = np.clip(
        0.025 + thermal * 0.900,
        0.0,
        1.0,
    )

    green = np.clip(
        0.030 + thermal * 0.925,
        0.0,
        1.0,
    )

    blue = np.clip(
        0.040 + thermal * 0.945,
        0.0,
        1.0,
    )

    rgb = np.stack(
        [red, green, blue],
        axis=-1,
    )

    # --------------------------------------------------------
    # C13-C07 nighttime low liquid-cloud discriminator.
    #
    # Positive brightness-temperature difference is used only
    # as a tint mask. The underlying C13 thermal image remains
    # intact, preserving land/ocean and IR cloud detail.
    # --------------------------------------------------------

    if low_cloud_btd is not None:

        btd = np.where(
            valid &
            np.isfinite(low_cloud_btd),
            low_cloud_btd,
            0.0,
        )

        # Smoothly activate blue tint roughly from
        # +1.5 K through +6 K.
        low_cloud = np.clip(
            (btd - 1.5) /
            (6.0 - 1.5),
            0.0,
            1.0,
        )

        low_cloud = (
            low_cloud *
            low_cloud *
            (
                3.0 -
                2.0 *
                low_cloud
            )
        )

        # Suppress enhancement on cold/high cloud tops.
        warm_gate = np.clip(
            (bt_safe - 242.0) /
            16.0,
            0.0,
            1.0,
        )

        # Reduce false blue enhancement over extremely warm
        # clear surfaces while still allowing warm low clouds.
        hot_surface_gate = np.clip(
            (297.0 - bt_safe) /
            8.0,
            0.0,
            1.0,
        )

        low_cloud *= (
            warm_gate *
            hot_surface_gate
        )

        # Blue-tinted version of the SAME C13 luminance.
        # This preserves cloud texture rather than replacing
        # low clouds with a flat color.
        blue_rgb = np.stack(
            [
                np.clip(
                    red * 0.58,
                    0.0,
                    1.0,
                ),
                np.clip(
                    green * 0.91 + 0.025,
                    0.0,
                    1.0,
                ),
                np.clip(
                    blue * 1.28 + 0.070,
                    0.0,
                    1.0,
                ),
            ],
            axis=-1,
        )

        mix = np.clip(
            low_cloud * 0.88,
            0.0,
            0.88,
        )[..., None]

        rgb = (
            rgb *
            (
                1.0 -
                mix
            )
            +
            blue_rgb *
            mix
        )

    # Very cold high cloud tops should become neutral white,
    # not blue.
    cold_white = np.clip(
        (235.0 - bt_safe) /
        30.0,
        0.0,
        1.0,
    )[..., None]

    rgb = (
        rgb *
        (
            1.0 -
            cold_white
        )
        +
        cold_white
    )

    rgb = np.clip(
        rgb,
        0.0,
        1.0,
    )

    rgb[~valid] = 0.0

    return rgb, valid


def solar_daylight_alpha(
    dt,
    bbox,
    width,
    height,
    night_full_degrees=-1.0,
    day_full_degrees=3.0,
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

    lat_rad = np.radians(
        lats
    )

    sin_elevation = (
        np.sin(lat_rad)[:, None] *
        np.sin(declination)
        +
        np.cos(lat_rad)[:, None] *
        np.cos(declination) *
        np.cos(hour_angle)[None, :]
    )

    night_full = math.sin(
        math.radians(
            night_full_degrees
        )
    )

    day_full = math.sin(
        math.radians(
            day_full_degrees
        )
    )

    if day_full <= night_full:
        raise ValueError(
            "day_full_degrees must exceed night_full_degrees"
        )

    alpha = np.clip(
        (
            sin_elevation -
            night_full
        ) /
        (
            day_full -
            night_full
        ),
        0.0,
        1.0,
    )

    # Smooth twilight crossover without blurring
    # either source image.
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


def render_scan(spec, group):
    paths = {}

    try:
        channels = ["01", "02", "03"]

        night_channel = spec.get("night_channel")
        low_cloud_channel = spec.get(
            "low_cloud_channel"
        )

        for channel in (
            night_channel,
            low_cloud_channel,
        ):
            if (
                channel and
                str(channel) not in channels
            ):
                channels.append(
                    str(channel)
                )

        for channel in channels:
            path = download_source(
                spec["source_bucket"],
                group["channels"][channel],
                f"-C{channel}.nc",
            )
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
            stride=2,
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

        day_rgb, day_finite = truecolor_rgb(
            blue_out,
            red_out,
            veggie_out,
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

            low_cloud_btd = None

            if low_cloud_channel:
                low_cloud_ir = (
                    read_brightness_temperature(
                        paths[
                            str(
                                low_cloud_channel
                            )
                        ],
                        gx,
                        gy,
                        stride=1,
                    )
                )

                low_cloud_bt = sample_grid(
                    low_cloud_ir,
                    gx,
                    gy,
                )

                low_cloud_btd = (
                    bt_out -
                    low_cloud_bt
                )

            night_rgb, night_finite = night_ir_rgb(
                bt_out,
                np.isfinite(bt_out),
                low_cloud_btd=
                    low_cloud_btd,
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
                "C01+C02+C03+C07+C13"
                if spec.get("low_cloud_channel")
                else "C01+C02+C03+C13"
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
        "lowCloudChannel": (
            f"C{spec['low_cloud_channel']}"
            if spec.get("low_cloud_channel")
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
            "transparentNoData": True,
            "resolutionKm": 1.0,
            "night": (
                "C13 Clean Longwave IR"
                if spec.get("night_channel")
                else None
            ),
            "terminatorBlendDegrees": (
                {
                    "nightFull": -1.0,
                    "dayFull": 3.0,
                }
                if spec.get("night_channel")
                else None
            ),
            "nightPalette": (
                "C13 thermal base with C13-C07 blue low-cloud enhancement"
                if spec.get("low_cloud_channel")
                else "C13 thermal base"
                if spec.get("night_channel")
                else None
            ),
            "lowCloudDetection": (
                "C13-C07 brightness-temperature difference"
                if spec.get("low_cloud_channel")
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


def process_platform(platform, spec, now):
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
            frame = render_scan(spec, group)
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


def lambda_handler(event, context):
    now = utcnow()
    results = []

    for platform, spec in PLATFORMS.items():
        results.append(
            process_platform(
                platform,
                spec,
                now,
            )
        )

    print(json.dumps(results, separators=(",", ":")))

    return {
        "statusCode": 200,
        "generated": iso_z(now),
        "results": results,
    }
