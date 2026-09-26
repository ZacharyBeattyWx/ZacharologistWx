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

PLATFORMS = {
    "East": {
        "satellite": "GOES-19",
        "source_bucket": os.getenv("SATELLITE_EAST_BUCKET", "noaa-goes19"),
        "prefix": "east",
        "sector": "CONUS",
        # Broader continental presentation while retaining the
        # native five-minute ABI CONUS/RadC source cadence.
        "bbox": (-126.0, 22.0, -58.0, 53.0),
    },
    "West": {
        "satellite": "GOES-18",
        "source_bucket": os.getenv("SATELLITE_WEST_BUCKET", "noaa-goes18"),
        "prefix": "west",
        "sector": "PACUS",
        "bbox": (-134.0, 20.0, -101.0, 53.0),
    },
}

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
    r"-M\dC(?P<channel>01|02|03)_G\d+_s(?P<scan>\d{11})"
)


def utcnow():
    return datetime.now(timezone.utc)


def iso_z(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_scan(scan):
    return datetime.strptime(scan, "%Y%j%H%M").replace(tzinfo=timezone.utc)


def source_hour_prefix(dt):
    return f"ABI-L1b-RadC/{dt:%Y}/{dt:%j}/{dt:%H}/"


def manifest_key(spec):
    return f"{TARGET_PREFIX}/{spec['prefix']}/manifest.json"


def frame_key(spec, scan_dt):
    stamp = scan_dt.strftime("%Y%m%dT%H%M00Z")
    return (
        f"{TARGET_PREFIX}/{spec['prefix']}/frames/"
        f"v{RENDER_VERSION}/{stamp}.webp"
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
        prefix = source_hour_prefix(hour)
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

    complete = [
        group
        for group in grouped.values()
        if all(
            channel in group["channels"]
            for channel in ("01", "02", "03")
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


def sector_may_have_daylight(dt, bbox):
    west, south, east, north = bbox
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


def read_reflectance(path, stride=1):
    with Dataset(path, "r") as dataset:
        rad = dataset.variables["Rad"]

        data = np.asarray(
            np.ma.filled(
                rad[::stride, ::stride],
                np.nan,
            ),
            dtype=np.float32,
        )

        kappa = float(np.asarray(dataset.variables["kappa0"][:]).squeeze())
        data *= kappa

        x = np.asarray(
            dataset.variables["x"][::stride],
            dtype=np.float64,
        )
        y = np.asarray(
            dataset.variables["y"][::stride],
            dtype=np.float64,
        )

        crs, height = projection_from_dataset(dataset)

    # GOES fixed-grid x/y values are scan angles in radians. PROJ geostationary
    # coordinates use projected metres, which are scan angle * perspective
    # point height.
    return {
        "data": data,
        "x0": float(x[0] * height),
        "dx": float((x[1] - x[0]) * height),
        "y0": float(y[0] * height),
        "dy": float((y[1] - y[0]) * height),
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
    paths = []

    try:
        # C02 is native 0.5 km while C01/C03 are 1 km. Read every second C02
        # pixel so all three source arrays operate at the intended 1-km output
        # scale without loading a 60-million-pixel red array into memory.
        for channel in ("01", "02", "03"):
            path = download_source(
                spec["source_bucket"],
                group["channels"][channel],
                f"-C{channel}.nc",
            )
            paths.append(path)

        blue = read_reflectance(paths[0], stride=1)
        red = read_reflectance(paths[1], stride=2)
        veggie = read_reflectance(paths[2], stride=1)

        gx, gy, _width, _height = output_grid(spec, blue["crs"])

        blue_out = sample_grid(blue, gx, gy)
        red_out = sample_grid(red, gx, gy)
        veggie_out = sample_grid(veggie, gx, gy)

        rgb, finite = truecolor_rgb(
            blue_out,
            red_out,
            veggie_out,
        )
        fraction = daylight_fraction(rgb, finite)

        if fraction < MIN_DAYLIGHT_FRACTION:
            print(
                f"{spec['satellite']} {group['scan']} skipped: "
                f"daylightFraction={fraction:.3f}"
            )
            return None

        payload, width, height = encode_webp(rgb, finite)
        key = frame_key(spec, group["time"])

        TARGET_S3.put_object(
            Bucket=TARGET_BUCKET,
            Key=key,
            Body=payload,
            ContentType="image/webp",
            CacheControl="public,max-age=31536000,immutable",
        )

        print(
            f"{spec['satellite']} published {group['scan']} "
            f"{width}x{height} daylightFraction={fraction:.3f} "
            f"bytes={len(payload)}"
        )

        return {
            "time": iso_z(group["time"]),
            "path": key[len(TARGET_PREFIX) + 1 :],
            "width": width,
            "height": height,
            "daylightFraction": round(fraction, 4),
            "scan": group["scan"],
        }
    finally:
        for path in paths:
            try:
                os.unlink(path)
            except OSError:
                pass


def publish_manifest(spec, existing, frames, checked_scans, now):
    frames_by_scan = {
        frame["scan"]: frame
        for frame in frames
        if isinstance(frame, dict) and frame.get("scan")
    }
    all_ordered = sorted(
        frames_by_scan.values(),
        key=lambda frame: frame["time"],
    )

    # Publish only the newest contiguous five-minute daylight run.
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

            # ABI CONUS/PACUS nominal cadence is five minutes.
            # Seven minutes allows minor timestamp irregularity without
            # accepting a genuine missing/nighttime gap.
            if gap > timedelta(minutes=7):
                break

            contiguous.append(frame)
            newer_time = frame_time

    ordered = list(reversed(contiguous))[-FRAME_COUNT:]

    output = {
        "version": 1,
        "renderVersion": RENDER_VERSION,
        "generated": iso_z(now),
        "platform": "East" if spec["prefix"] == "east" else "West",
        "satellite": spec["satellite"],
        "sector": spec["sector"],
        "product": "CIMSS Natural True Color",
        "sourceProduct": "ABI-L1b-RadC C01+C02+C03",
        "cadenceMinutes": 5,
        "frameCount": len(ordered),
        "targetFrameCount": FRAME_COUNT,
        "daytimeOnly": True,
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

    if existing.get("renderVersion") != RENDER_VERSION:
        if existing:
            print(
                f"{spec['satellite']} resetting manifest for "
                f"renderVersion={RENDER_VERSION}"
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
        candidate_floor = newest_existing - timedelta(
            minutes=(FRAME_COUNT * 5) + 10
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
            spec["bbox"],
        ):
            checked.append(group["scan"])
            checked_set.add(group["scan"])
            skipped += 1
            continue

        if attempted >= MAX_RENDER_PER_PLATFORM:
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
