import gzip
import json
import math
import os
import tempfile
from datetime import datetime, timedelta, timezone

import boto3
import numpy as np
from botocore import UNSIGNED
from botocore.config import Config
from netCDF4 import Dataset


SOURCE_BUCKET = os.getenv("GLM_SOURCE_BUCKET", "noaa-goes19")
TARGET_BUCKET = os.environ["RADAR_BUCKET"]
TARGET_PREFIX = os.getenv("GLM_PREFIX", "glm-goes19").strip("/")

HISTORY_MINUTES = int(os.getenv("GLM_HISTORY_MINUTES", "65"))
MAX_FILES_PER_RUN = int(os.getenv("GLM_MAX_FILES_PER_RUN", "36"))

# North America / nearby waters. Keeps the browser payload practical while
# covering the area used by the ZacharologistWx national lightning viewer.
WEST = float(os.getenv("GLM_WEST", "-135"))
EAST = float(os.getenv("GLM_EAST", "-55"))
SOUTH = float(os.getenv("GLM_SOUTH", "10"))
NORTH = float(os.getenv("GLM_NORTH", "60"))

SOURCE_S3 = boto3.client(
    "s3",
    region_name="us-east-1",
    config=Config(signature_version=UNSIGNED),
)
TARGET_S3 = boto3.client("s3")


def utcnow():
    return datetime.now(timezone.utc)


def hour_prefix(dt):
    return f"GLM-L2-LCFA/{dt:%Y}/{dt:%j}/{dt:%H}/"


def parse_time_units(units):
    # GLM variables use forms such as:
    # "seconds since 2026-09-24 00:01:20.000"
    marker = "seconds since "
    value = str(units or "")
    if not value.lower().startswith(marker):
        raise ValueError(f"Unsupported GLM time units: {value}")

    stamp = value[len(marker):].strip().replace("Z", "+00:00")
    base = datetime.fromisoformat(stamp)

    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    else:
        base = base.astimezone(timezone.utc)

    return int(base.timestamp() * 1000)


def read_existing():
    key = f"{TARGET_PREFIX}/latest.json"

    try:
        response = TARGET_S3.get_object(Bucket=TARGET_BUCKET, Key=key)
        raw = response["Body"].read()

        if (
            response.get("ContentEncoding") == "gzip"
            or raw[:2] == b"\x1f\x8b"
        ):
            raw = gzip.decompress(raw)

        data = json.loads(raw.decode("utf-8"))

        if not isinstance(data, dict):
            raise ValueError("existing GLM feed is not an object")

        return data
    except TARGET_S3.exceptions.NoSuchKey:
        return {}
    except Exception as exc:
        print(f"Existing GLM feed unavailable: {exc}")
        return {}


def list_recent_source_objects(now):
    cutoff = now - timedelta(minutes=HISTORY_MINUTES + 5)
    objects = {}

    # Three hourly prefixes safely cover the history window across hour/day
    # boundaries and give us room to recover after a delayed run.
    for offset in range(3):
        hour = now - timedelta(hours=offset)
        prefix = hour_prefix(hour)

        paginator = SOURCE_S3.get_paginator("list_objects_v2")

        for page in paginator.paginate(
            Bucket=SOURCE_BUCKET,
            Prefix=prefix,
        ):
            for obj in page.get("Contents", []):
                key = obj["Key"]

                if not key.endswith(".nc"):
                    continue

                if obj["LastModified"] < cutoff:
                    continue

                objects[key] = obj["LastModified"]

    return sorted(
        objects.items(),
        key=lambda item: item[1],
        reverse=True,
    )


def variable_array(dataset, name, fill=np.nan):
    variable = dataset.variables[name]
    return np.asarray(
        np.ma.filled(variable[:], fill)
    )


def parse_glm_file(key, cutoff_ms):
    print(f"Reading {key}")

    response = SOURCE_S3.get_object(
        Bucket=SOURCE_BUCKET,
        Key=key,
    )

    payload = response["Body"].read()

    with tempfile.NamedTemporaryFile(
        suffix=".nc",
        dir="/tmp",
    ) as temp:
        temp.write(payload)
        temp.flush()

        with Dataset(temp.name, "r") as dataset:
            if "flash_lat" not in dataset.variables:
                return []

            lat = variable_array(dataset, "flash_lat").astype(float)
            lon = variable_array(dataset, "flash_lon").astype(float)

            time_var = dataset.variables[
                "flash_time_offset_of_first_event"
            ]
            offsets = np.asarray(
                np.ma.filled(time_var[:], np.nan),
                dtype=float,
            )

            base_ms = parse_time_units(
                getattr(time_var, "units", "")
            )
            time_ms = base_ms + offsets * 1000.0

            if "flash_quality_flag" in dataset.variables:
                quality = np.asarray(
                    np.ma.filled(
                        dataset.variables["flash_quality_flag"][:],
                        0,
                    ),
                    dtype=int,
                )
            else:
                quality = np.zeros(lat.shape, dtype=int)

            valid = (
                np.isfinite(lat)
                & np.isfinite(lon)
                & np.isfinite(time_ms)
                & (quality == 0)
                & (lat >= SOUTH)
                & (lat <= NORTH)
                & (lon >= WEST)
                & (lon <= EAST)
                & (time_ms >= cutoff_ms)
            )

            indexes = np.flatnonzero(valid)

            # Compact format:
            # [longitude, latitude, UTC epoch milliseconds]
            return [
                [
                    round(float(lon[i]), 4),
                    round(float(lat[i]), 4),
                    int(round(float(time_ms[i]))),
                ]
                for i in indexes
            ]


def lambda_handler(event, context):
    now = utcnow()
    now_ms = int(now.timestamp() * 1000)
    cutoff_ms = now_ms - HISTORY_MINUTES * 60 * 1000

    existing = read_existing()

    flashes = [
        item
        for item in existing.get("flashes", [])
        if (
            isinstance(item, list)
            and len(item) >= 3
            and cutoff_ms <= int(item[2]) <= now_ms + 300000
        )
    ]

    processed_sources = set(existing.get("sources", []))

    candidates = list_recent_source_objects(now)

    new_keys = [
        key
        for key, _modified in candidates
        if key not in processed_sources
    ][:MAX_FILES_PER_RUN]

    print(
        f"Candidates={len(candidates)} "
        f"new={len(new_keys)} "
        f"existingFlashes={len(flashes)}"
    )

    completed = []

    for key in new_keys:
        try:
            flashes.extend(
                parse_glm_file(
                    key,
                    cutoff_ms,
                )
            )
            completed.append(key)
        except Exception as exc:
            print(f"Failed {key}: {exc}")

    processed_sources.update(completed)

    # Keep the source-key history bounded. ~3 files/min means 300 entries
    # comfortably covers more than the visible hour.
    current_candidate_keys = {
        key for key, _modified in candidates
    }

    processed_sources = [
        key
        for key in processed_sources
        if key in current_candidate_keys
    ]

    processed_sources = processed_sources[-300:]

    # Re-trim after ingest and sort chronologically for fast browser playback.
    flashes = [
        item
        for item in flashes
        if cutoff_ms <= int(item[2]) <= now_ms + 300000
    ]

    flashes.sort(key=lambda item: item[2])

    latest_ms = flashes[-1][2] if flashes else None

    last_hour_cutoff = (
        (latest_ms or now_ms) - 60 * 60 * 1000
    )

    count_last_hour = sum(
        1
        for item in flashes
        if item[2] >= last_hour_cutoff
    )

    output = {
        "version": 1,
        "generated": now.isoformat().replace("+00:00", "Z"),
        "satellite": "GOES-19",
        "product": "GLM-L2-LCFA",
        "historyMinutes": HISTORY_MINUTES,
        "displayWindowMinutes": 60,
        "latestTime": (
            datetime.fromtimestamp(
                latest_ms / 1000,
                timezone.utc,
            )
            .isoformat()
            .replace("+00:00", "Z")
            if latest_ms
            else None
        ),
        "countLastHour": count_last_hour,
        "sources": processed_sources,
        "flashes": flashes,
    }

    raw = json.dumps(
        output,
        separators=(",", ":"),
    ).encode("utf-8")

    compressed = gzip.compress(raw, compresslevel=6)

    TARGET_S3.put_object(
        Bucket=TARGET_BUCKET,
        Key=f"{TARGET_PREFIX}/latest.json",
        Body=compressed,
        ContentType="application/json",
        ContentEncoding="gzip",
        CacheControl="public,max-age=15,stale-while-revalidate=45",
    )

    print(
        f"Published flashes={len(flashes)} "
        f"lastHour={count_last_hour} "
        f"rawBytes={len(raw)} "
        f"gzipBytes={len(compressed)}"
    )

    return {
        "statusCode": 200,
        "flashes": len(flashes),
        "countLastHour": count_last_hour,
        "newGranules": len(completed),
        "latestTime": output["latestTime"],
    }
