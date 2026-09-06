#!/usr/bin/env python3
"""Publish a rolling native-resolution numeric MRALA archive to S3.

This publisher is intentionally isolated from the existing production MRMS and
NEXRAD publishers. It keeps the full NOAA/NCEP MRMS
MergedReflectivityAtLowestAltitude grid, quantizes each native radar cell to one
uint8 dBZ code, gzip-compresses the frame for transfer, and publishes a rolling
manifest suitable for the GPU numeric-texture renderer.

Numeric encoding:
  0       = no data
  1..255  = -32.0..+95.0 dBZ in 0.5 dBZ increments
"""

from __future__ import annotations

import gzip
import html
import json
import os
import re
import shutil
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin

import boto3
import numpy as np
import requests
from botocore.exceptions import ClientError

import sys

RADAR_SCRIPT_DIR = Path(__file__).resolve().parent / "scripts" / "radar"
sys.path.insert(0, str(RADAR_SCRIPT_DIR))

import render_mrms_mosaic as mrms  # noqa: E402

S3 = boto3.client("s3")

PRODUCT = "MergedReflectivityAtLowestAltitude"
PRODUCT_KEY = "mrala"
DIRECTORY_URL = f"https://mrms.ncep.noaa.gov/2D/{PRODUCT}/"
HISTORICAL_NAME_RE = re.compile(
    rf"MRMS_{re.escape(PRODUCT)}_00\.50_(?P<stamp>\d{{8}}-\d{{6}})\.grib2\.gz"
)

NUMERIC_NODATA_CODE = 0
NUMERIC_MIN_CODE = 1
NUMERIC_MAX_CODE = 255
NUMERIC_MIN_DBZ = -32.0
NUMERIC_STEP_DBZ = 0.5
NUMERIC_MAX_DBZ = (
    NUMERIC_MIN_DBZ
    + (NUMERIC_MAX_CODE - NUMERIC_MIN_CODE) * NUMERIC_STEP_DBZ
)


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, value)


def _event_int(event: dict, name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(event.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _timestamp_from_name(name: str) -> datetime:
    match = HISTORICAL_NAME_RE.fullmatch(name)
    if not match:
        raise ValueError(f"Unexpected MRALA filename: {name}")
    return datetime.strptime(match.group("stamp"), "%Y%m%d-%H%M%S").replace(
        tzinfo=UTC
    )


def _slug_from_name(name: str) -> str:
    match = HISTORICAL_NAME_RE.fullmatch(name)
    if not match:
        raise ValueError(f"Unexpected MRALA filename: {name}")
    return match.group("stamp")


def _list_recent_sources(
    session: requests.Session,
    window_minutes: int,
) -> list[dict]:
    print(f"Listing {DIRECTORY_URL}", flush=True)
    response = session.get(DIRECTORY_URL, timeout=45)
    response.raise_for_status()

    filenames = sorted(
        {
            match.group(0)
            for match in HISTORICAL_NAME_RE.finditer(html.unescape(response.text))
        },
        key=_timestamp_from_name,
    )
    if not filenames:
        raise RuntimeError("NOAA MRMS directory did not contain timestamped MRALA files")

    newest_time = _timestamp_from_name(filenames[-1])
    cutoff = newest_time - timedelta(minutes=max(1, int(window_minutes)))
    selected = [
        name
        for name in filenames
        if _timestamp_from_name(name) >= cutoff
    ]

    if len(selected) < 2:
        selected = filenames[-2:]

    return [
        {
            "name": name,
            "url": urljoin(DIRECTORY_URL, name),
            "filename_time": _timestamp_from_name(name),
            "slug": _slug_from_name(name),
        }
        for name in selected
    ]


def _load_manifest(bucket: str, key: str) -> dict:
    try:
        response = S3.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in {"NoSuchKey", "404"}:
            return {}
        raise
    return json.loads(response["Body"].read().decode("utf-8"))


def _upload_manifest(bucket: str, key: str, manifest: dict) -> None:
    S3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(manifest, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-cache,max-age=0,must-revalidate",
    )


def _decode_source(session: requests.Session, source: dict) -> dict:
    print(f"Download {source['name']}", flush=True)
    response = session.get(source["url"], timeout=60)
    response.raise_for_status()

    with tempfile.TemporaryDirectory(prefix="mrala-native-numeric-") as temp_name:
        temp_root = Path(temp_name)
        gz_path = temp_root / source["name"]
        grib_path = temp_root / source["name"].removesuffix(".gz")
        gz_path.write_bytes(response.content)
        with gzip.open(gz_path, "rb") as compressed, grib_path.open("wb") as target:
            shutil.copyfileobj(compressed, target)
        return mrms.decode_mrms_grib2(grib_path)


def _encode_numeric_grid(grid: np.ndarray) -> np.ndarray:
    sampled = np.asarray(grid, dtype=np.float32)
    encoded = np.zeros(sampled.shape, dtype=np.uint8)
    valid = (
        np.isfinite(sampled)
        & (sampled != mrms.NODATA)
        & (sampled > -9000.0)
    )
    if not np.any(valid):
        return encoded

    clipped = np.clip(sampled[valid], NUMERIC_MIN_DBZ, NUMERIC_MAX_DBZ)
    codes = (
        np.rint((clipped - NUMERIC_MIN_DBZ) / NUMERIC_STEP_DBZ)
        .astype(np.int16)
        + NUMERIC_MIN_CODE
    )
    encoded[valid] = np.clip(
        codes,
        NUMERIC_MIN_CODE,
        NUMERIC_MAX_CODE,
    ).astype(np.uint8)
    return encoded



def _downsample_nearest_uint8(
    grid: np.ndarray,
    max_width: int,
) -> np.ndarray:
    """Create a lightweight numeric overview without inventing dBZ values."""
    sampled = np.asarray(grid, dtype=np.uint8)
    height, width = sampled.shape

    if width <= max_width:
        return np.ascontiguousarray(sampled)

    scale = max_width / float(width)

    out_width = max(
        1,
        int(round(width * scale)),
    )

    out_height = max(
        1,
        int(round(height * scale)),
    )

    x_idx = (
        np.linspace(
            0,
            width - 1,
            out_width,
        )
        .round()
        .astype(np.int32)
    )

    y_idx = (
        np.linspace(
            0,
            height - 1,
            out_height,
        )
        .round()
        .astype(np.int32)
    )

    return np.ascontiguousarray(
        sampled[np.ix_(y_idx, x_idx)]
    )


def _overview_shape(
    width: int,
    height: int,
    max_width: int,
) -> tuple[int, int]:
    if width <= max_width:
        return width, height

    scale = max_width / float(width)

    return (
        max(1, int(round(width * scale))),
        max(1, int(round(height * scale))),
    )


def _read_numeric_grid(
    bucket: str,
    key: str,
    width: int,
    height: int,
) -> np.ndarray:
    """Read an existing native numeric frame so old frames can gain LOD."""
    response = S3.get_object(
        Bucket=bucket,
        Key=key,
    )

    payload = response["Body"].read()

    if payload[:2] == b"\x1f\x8b":
        payload = gzip.decompress(payload)

    expected = width * height

    if len(payload) != expected:
        raise RuntimeError(
            f"Existing numeric frame {key} has "
            f"{len(payload)} bytes; expected {expected}"
        )

    return (
        np.frombuffer(
            payload,
            dtype=np.uint8,
        )
        .reshape(
            height,
            width,
        )
        .copy()
    )


def _upload_numeric_grid(
    bucket: str,
    key: str,
    encoded: np.ndarray,
    compresslevel: int,
) -> tuple[int, int]:
    raw = np.ascontiguousarray(encoded, dtype=np.uint8).tobytes(order="C")
    compressed = gzip.compress(
        raw,
        compresslevel=max(1, min(9, int(compresslevel))),
    )
    S3.put_object(
        Bucket=bucket,
        Key=key,
        Body=compressed,
        ContentType="application/octet-stream",
        ContentEncoding="gzip",
        CacheControl="public,max-age=31536000,immutable",
        Metadata={
            "zwx-format": "uint8-dbz-grid-v1",
            "zwx-width": str(encoded.shape[1]),
            "zwx-height": str(encoded.shape[0]),
        },
    )
    return len(raw), len(compressed)


def _delete_frames(bucket: str, prefix: str, frame_ids: list[str]) -> None:
    if not frame_ids:
        return
    for start in range(0, len(frame_ids), 1000):
        chunk = frame_ids[start : start + 1000]
        objects = []

        for frame_id in chunk:
            objects.extend(
                [
                    {
                        "Key":
                            f"{prefix}/frames/{frame_id}.dbz"
                    },
                    {
                        "Key":
                            f"{prefix}/overview/{frame_id}.dbz"
                    },
                ]
            )

        S3.delete_objects(
            Bucket=bucket,
            Delete={
                "Objects": objects,
                "Quiet": True,
            },
        )


def publish_mrala_numeric(event: dict | None = None) -> dict:
    event = event or {}
    if event.get("skipMralaNumeric"):
        return {"status": "skipped", "reason": "event skipMralaNumeric=true"}

    bucket = os.environ["RADAR_BUCKET"]
    prefix = os.environ.get(
        "MRALA_NUMERIC_PREFIX",
        "mrms-native-numeric",
    ).strip("/")
    history_minutes = _env_int(
        "MRALA_NUMERIC_HISTORY_MINUTES",
        180,
        minimum=10,
    )
    max_render = _event_int(
        event,
        "mralaMaxRender",
        _env_int("MRALA_NUMERIC_MAX_RENDER_PER_RUN", 6, minimum=1),
        minimum=1,
    )
    compresslevel = _env_int(
        "MRALA_NUMERIC_COMPRESSLEVEL",
        4,
        minimum=1,
    )
    compresslevel = min(9, compresslevel)

    overview_max_width = _env_int(
        "MRALA_NUMERIC_OVERVIEW_MAX_WIDTH",
        3500,
        minimum=512,
    )

    manifest_key = f"{prefix}/manifest.json"

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": mrms.USER_AGENT,
            "Accept": "*/*",
            "Cache-Control": "no-cache",
        }
    )

    sources = _list_recent_sources(session, history_minutes)
    newest_time = sources[-1]["filename_time"]
    cutoff = newest_time - timedelta(minutes=history_minutes)

    existing = _load_manifest(bucket, manifest_key)
    old_frames = [
        dict(frame)
        for frame in (existing.get("frames") or [])
        if frame.get("id") and frame.get("valid_time") and frame.get("dbz")
    ]
    old_by_id = {str(frame["id"]): frame for frame in old_frames}

    retained = {
        frame_id: frame
        for frame_id, frame in old_by_id.items()
        if _parse_iso(frame["valid_time"]) >= cutoff
    }

    missing = [
        source
        for source in sources
        if source["filename_time"] >= cutoff
        and source["slug"] not in retained
    ]

    # Work newest-first. After the live edge is current, this naturally grows
    # one continuous archive backward from the newest retained frame.
    selected = list(reversed(missing))[:max_render]

    remaining_budget = max(
        0,
        max_render - len(selected),
    )

    upgrade_candidates = sorted(
        (
            frame
            for frame in retained.values()
            if not frame.get("overview")
        ),
        key=lambda frame: _parse_iso(
            frame["valid_time"]
        ),
        reverse=True,
    )

    upgrade_selected = (
        upgrade_candidates[:remaining_budget]
    )

    geometry: tuple[list[float], int, int] | None = None
    if existing.get("bounds") and existing.get("imageWidth") and existing.get("imageHeight"):
        geometry = (
            [float(value) for value in existing["bounds"]],
            int(existing["imageWidth"]),
            int(existing["imageHeight"]),
        )

    rendered_ids: list[str] = []
    upgraded_overview_ids: list[str] = []

    rendered_raw = 0
    rendered_compressed = 0

    overview_raw = 0
    overview_compressed = 0

    for source in selected:
        decoded = _decode_source(session, source)
        grid = np.asarray(decoded["grid"], dtype=np.float32)
        valid = (
            np.isfinite(grid)
            & (grid != mrms.NODATA)
            & (grid > -9000.0)
        )
        if not np.any(valid):
            raise RuntimeError(
                f"{source['name']} decoded with no valid reflectivity"
            )

        current_geometry = (
            [float(value) for value in decoded["bounds"]],
            int(grid.shape[1]),
            int(grid.shape[0]),
        )
        if geometry is None:
            geometry = current_geometry
        elif current_geometry != geometry:
            raise RuntimeError(
                f"MRALA native geometry changed: {current_geometry} != {geometry}"
            )

        encoded = _encode_numeric_grid(grid)
        frame_id = source["slug"]
        numeric_key = f"{prefix}/frames/{frame_id}.dbz"
        raw_bytes, compressed_bytes = _upload_numeric_grid(
            bucket,
            numeric_key,
            encoded,
            compresslevel,
        )

        overview = _downsample_nearest_uint8(
            encoded,
            overview_max_width,
        )

        overview_key = (
            f"{prefix}/overview/{frame_id}.dbz"
        )

        (
            overview_raw_bytes,
            overview_compressed_bytes,
        ) = _upload_numeric_grid(
            bucket,
            overview_key,
            overview,
            compresslevel,
        )

        overview_raw += overview_raw_bytes
        overview_compressed += overview_compressed_bytes

        valid_time = decoded.get("valid_time") or source["filename_time"]

        frame = {
            "id": frame_id,
            "valid_time": valid_time.isoformat(),
            "dbz": f"frames/{frame_id}.dbz",
            "dbzRawBytes": raw_bytes,
            "dbzCompressedBytes": compressed_bytes,

            "overview":
                f"overview/{frame_id}.dbz",

            "overviewWidth":
                int(overview.shape[1]),

            "overviewHeight":
                int(overview.shape[0]),

            "overviewRawBytes":
                overview_raw_bytes,

            "overviewCompressedBytes":
                overview_compressed_bytes,

            "source_name": source["name"],
            "product": PRODUCT,
            "productKey": PRODUCT_KEY,
            "minDbz": round(float(np.min(grid[valid])), 2),
            "maxDbz": round(float(np.max(grid[valid])), 2),
        }
        retained[frame_id] = frame
        rendered_ids.append(frame_id)
        rendered_raw += raw_bytes
        rendered_compressed += compressed_bytes

        print(
            f"Published {frame_id}: {grid.shape[1]}x{grid.shape[0]} "
            f"raw={raw_bytes / 1048576:.2f} MiB "
            f"gzip={compressed_bytes / 1048576:.2f} MiB",
            flush=True,
        )


    if geometry is not None and upgrade_selected:
        _, native_width, native_height = geometry

        for frame in upgrade_selected:
            frame_id = str(frame["id"])

            native_key = (
                f"{prefix}/{frame['dbz']}"
            )

            encoded = _read_numeric_grid(
                bucket,
                native_key,
                native_width,
                native_height,
            )

            overview = _downsample_nearest_uint8(
                encoded,
                overview_max_width,
            )

            overview_key = (
                f"{prefix}/overview/{frame_id}.dbz"
            )

            (
                overview_raw_bytes,
                overview_compressed_bytes,
            ) = _upload_numeric_grid(
                bucket,
                overview_key,
                overview,
                compresslevel,
            )

            frame["overview"] = (
                f"overview/{frame_id}.dbz"
            )

            frame["overviewWidth"] = int(
                overview.shape[1]
            )

            frame["overviewHeight"] = int(
                overview.shape[0]
            )

            frame["overviewRawBytes"] = (
                overview_raw_bytes
            )

            frame["overviewCompressedBytes"] = (
                overview_compressed_bytes
            )

            retained[frame_id] = frame

            upgraded_overview_ids.append(
                frame_id
            )

            overview_raw += overview_raw_bytes
            overview_compressed += (
                overview_compressed_bytes
            )

            print(
                f"Overview backfill {frame_id}: "
                f"{overview.shape[1]}x{overview.shape[0]} "
                f"gzip="
                f"{overview_compressed_bytes / 1048576:.2f} MiB",
                flush=True,
            )


    if geometry is None:
        raise RuntimeError("MRALA native geometry is unavailable")

    frames = sorted(
        retained.values(),
        key=lambda frame: _parse_iso(frame["valid_time"]),
    )
    if not frames:
        raise RuntimeError("No MRALA numeric frames are available")

    keep_ids = {str(frame["id"]) for frame in frames}
    pruned_ids = sorted(set(old_by_id) - keep_ids)
    _delete_frames(bucket, prefix, pruned_ids)

    bounds, width, height = geometry

    (
        overview_width,
        overview_height,
    ) = _overview_shape(
        width,
        height,
        overview_max_width,
    )

    remaining_overview = sum(
        1
        for frame in retained.values()
        if not frame.get("overview")
    )

    now = datetime.now(UTC)
    manifest = {
        "generated_at": now.isoformat(),
        "revision": int(now.timestamp()),
        "mode": "mrms-native-numeric-texture-archive",
        "source": f"NOAA/NCEP MRMS {PRODUCT}",
        "product": PRODUCT,
        "productKey": PRODUCT_KEY,
        "units": "dBZ",
        "bounds": bounds,
        "imageWidth": width,
        "imageHeight": height,
        "sourceGridWidth": width,
        "sourceGridHeight": height,

        "lod": {
            "overview": {
                "width": overview_width,
                "height": overview_height,
                "pathField": "overview",
                "recommendedMaxZoom": 4.9,
            },
            "native": {
                "width": width,
                "height": height,
                "pathField": "dbz",
                "recommendedMinZoom": 4.6,
            },
        },

        "historyWindowMinutes": history_minutes,
        "observationCount": len(frames),
        "startTime": frames[0]["valid_time"],
        "endTime": frames[-1]["valid_time"],
        "numericEncoding": {
            "format": "uint8-dbz-grid-v1",
            "layout": "row-major",
            "compression": "gzip-http-content-encoding",
            "noDataCode": NUMERIC_NODATA_CODE,
            "minCode": NUMERIC_MIN_CODE,
            "maxCode": NUMERIC_MAX_CODE,
            "minDbz": NUMERIC_MIN_DBZ,
            "stepDbz": NUMERIC_STEP_DBZ,
            "maxDbz": NUMERIC_MAX_DBZ,
            "bytesPerPixel": 1,
        },
        "publisher": {
            "platform": "aws-lambda-s3",
            "strategy": "mrala-numeric-lod-v2",
        },
        "frames": frames,
    }
    _upload_manifest(bucket, manifest_key, manifest)

    return {
        "status": "published" if rendered_ids else "current",
        "product": PRODUCT,
        "prefix": prefix,
        "historyMinutes": history_minutes,
        "frameCount": len(frames),
        "rendered": rendered_ids,
        "remainingMissing": max(0, len(missing) - len(rendered_ids)),
        "latest": frames[-1]["valid_time"],
        "grid": f"{width}x{height}",

        "overviewGrid":
            f"{overview_width}x{overview_height}",

        "upgradedOverview":
            upgraded_overview_ids,

        "remainingOverview":
            remaining_overview,

        "gpuMiBPerFrame":
            round(width * height / 1048576, 2),

        "overviewGpuMiBPerFrame":
            round(
                overview_width
                * overview_height
                / 1048576,
                2,
            ),
        "renderedRawMiB": round(rendered_raw / 1048576, 2),
        "renderedGzipMiB": round(rendered_compressed / 1048576, 2),
        "pruned": len(pruned_ids),
    }


def lambda_handler(event, context):
    return publish_mrala_numeric(event)
