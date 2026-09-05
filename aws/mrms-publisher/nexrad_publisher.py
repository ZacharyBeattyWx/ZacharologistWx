#!/usr/bin/env python3
"""Publish a separate Unidata NEXRAD N0B archive beside the MRMS archive.

This feed is intentionally independent of MRMS. It gives the browser a
traditional base-reflectivity mosaic with negative-dBZ/clear-air returns while
MRMS remains the stable nationwide fallback.

Each observation is published in two representations:
  * lossless RGBA WebP for the existing browser/test renderer
  * gzipped row-major uint8 dBZ grid for the numeric-texture experiment

Numeric encoding:
  0       = no data
  1..255  = -32.0..+95.0 dBZ in 0.5 dBZ increments

The numeric path lets WebGL keep one byte per radar pixel and apply the palette
in a shader instead of decoding/storing a four-byte RGBA image per pixel.
"""

from __future__ import annotations

import gzip
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import boto3
import numpy as np
from PIL import Image
import requests

RADAR_SCRIPT_DIR = Path(__file__).resolve().parent / "scripts" / "radar"
sys.path.insert(0, str(RADAR_SCRIPT_DIR))

import render_mrms_mosaic as palette  # noqa: E402
import render_unidata_nexrad_mosaic as nexrad  # noqa: E402

S3 = boto3.client("s3")

NUMERIC_NODATA_CODE = 0
NUMERIC_MIN_CODE = 1
NUMERIC_MAX_CODE = 255
NUMERIC_MIN_DBZ = -32.0
NUMERIC_STEP_DBZ = 0.5
NUMERIC_MAX_DBZ = NUMERIC_MIN_DBZ + (NUMERIC_MAX_CODE - NUMERIC_MIN_CODE) * NUMERIC_STEP_DBZ


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, value)


def _parse_bounds(value: str | None) -> tuple[float, float, float, float]:
    raw = str(value or "-130,20,-60,55")
    parts = [part.strip() for part in raw.split(",") if part.strip()]
    if len(parts) != 4:
        raise ValueError(f"NEXRAD_BOUNDS must contain west,south,east,north; got {raw!r}")
    west, south, east, north = map(float, parts)
    if not (west < east and south < north):
        raise ValueError(f"Invalid NEXRAD_BOUNDS ordering: {raw!r}")
    return west, south, east, north


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _load_manifest(bucket: str, key: str) -> dict:
    try:
        response = S3.get_object(Bucket=bucket, Key=key)
    except S3.exceptions.NoSuchKey:
        return {}
    except Exception as exc:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
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


def _upload_image(bucket: str, key: str, path: Path) -> None:
    S3.upload_file(
        str(path),
        bucket,
        key,
        ExtraArgs={
            "ContentType": "image/webp",
            "CacheControl": "public,max-age=31536000,immutable",
        },
    )


def _encode_numeric_grid(dbz: np.ndarray) -> np.ndarray:
    """Quantize a float dBZ grid into the public 8-bit numeric texture format."""
    sampled = np.asarray(dbz, dtype=np.float32)
    encoded = np.zeros(sampled.shape, dtype=np.uint8)
    valid = np.isfinite(sampled) & (sampled > -9000)
    if not np.any(valid):
        return encoded

    clipped = np.clip(sampled[valid], NUMERIC_MIN_DBZ, NUMERIC_MAX_DBZ)
    codes = np.rint((clipped - NUMERIC_MIN_DBZ) / NUMERIC_STEP_DBZ).astype(np.int16) + NUMERIC_MIN_CODE
    encoded[valid] = np.clip(codes, NUMERIC_MIN_CODE, NUMERIC_MAX_CODE).astype(np.uint8)
    return encoded


def _upload_numeric_grid(bucket: str, key: str, encoded: np.ndarray) -> tuple[int, int]:
    raw = np.ascontiguousarray(encoded, dtype=np.uint8).tobytes(order="C")
    compressed = gzip.compress(raw, compresslevel=4)
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


def _delete_frame(bucket: str, prefix: str, frame_id: str) -> None:
    S3.delete_objects(
        Bucket=bucket,
        Delete={
            "Objects": [
                {"Key": f"{prefix}/frames/{frame_id}.webp"},
                {"Key": f"{prefix}/frames/{frame_id}.dbz"},
            ],
            "Quiet": True,
        },
    )


def publish_nexrad_n0b(event: dict | None = None) -> dict:
    event = event or {}
    if event.get("skipNexrad"):
        return {"status": "skipped", "reason": "event skipNexrad=true"}

    bucket = os.environ["RADAR_BUCKET"]
    prefix = os.environ.get("NEXRAD_PREFIX", "nexrad-n0b").strip("/")
    history_minutes = _env_int(
        "NEXRAD_HISTORY_MINUTES",
        _env_int("HISTORY_MINUTES", 24 * 60, minimum=5),
        minimum=5,
    )
    max_width = _env_int("NEXRAD_MAX_WIDTH", 4096, minimum=512)
    bounds = _parse_bounds(os.environ.get("NEXRAD_BOUNDS"))
    manifest_key = f"{prefix}/manifest.json"

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "ZacharologistWx/AWS-NEXRAD-N0B-publisher",
            "Accept": "*/*",
            "Cache-Control": "no-cache",
        }
    )

    source = nexrad.discover_latest_gini(session, "n0b")
    source_time = source["timestamp"]
    if source_time.year <= 1900:
        source_time = datetime.now(UTC)
    source_time = source_time.astimezone(UTC)
    frame_id = source_time.strftime("%Y%m%d-%H%M%S")

    existing = _load_manifest(bucket, manifest_key)
    existing_frames = [
        dict(frame)
        for frame in (existing.get("frames") or [])
        if frame.get("id") and frame.get("valid_time")
    ]
    existing_by_id = {str(frame["id"]): frame for frame in existing_frames}

    if frame_id in existing_by_id and existing_by_id[frame_id].get("dbz"):
        return {
            "status": "no-change",
            "product": "N0B",
            "latest": source_time.isoformat(),
            "frameCount": len(existing_frames),
            "numeric": True,
        }

    response = session.get(source["file_url"], timeout=60)
    response.raise_for_status()
    gini = nexrad.decode_gini(response.content)
    if source["timestamp"].year <= 1900:
        source_time = gini.prod_desc.datetime
        if source_time.tzinfo is None:
            source_time = source_time.replace(tzinfo=UTC)
        source_time = source_time.astimezone(UTC)
        frame_id = source_time.strftime("%Y%m%d-%H%M%S")

    dbz = nexrad.reproject_gini_to_lonlat(gini, "N0B", bounds, max_width)
    valid = np.isfinite(dbz) & (dbz > -9000)
    if not np.any(valid):
        raise RuntimeError("NEXRAD N0B reprojection produced no valid reflectivity pixels")

    work_root = Path("/tmp/nexrad-n0b")
    work_root.mkdir(parents=True, exist_ok=True)

    image_path = work_root / f"{frame_id}.webp"
    rgba = palette.colorize_dbz_grid_for_tiles(dbz)
    Image.fromarray(rgba, mode="RGBA").save(
        image_path,
        format="WEBP",
        lossless=True,
        method=4,
    )
    image_key = f"{prefix}/frames/{frame_id}.webp"
    _upload_image(bucket, image_key, image_path)

    encoded = _encode_numeric_grid(dbz)
    numeric_key = f"{prefix}/frames/{frame_id}.dbz"
    numeric_raw_bytes, numeric_compressed_bytes = _upload_numeric_grid(
        bucket,
        numeric_key,
        encoded,
    )

    frame = {
        "id": frame_id,
        "valid_time": source_time.isoformat(),
        "image": f"frames/{frame_id}.webp",
        "dbz": f"frames/{frame_id}.dbz",
        "dbzRawBytes": numeric_raw_bytes,
        "dbzCompressedBytes": numeric_compressed_bytes,
        "product": "N0B",
        "dataset": source["dataset_name"],
        "minDbz": round(float(np.min(dbz[valid])), 2),
        "maxDbz": round(float(np.max(dbz[valid])), 2),
    }
    existing_by_id[frame_id] = frame

    cutoff = source_time - timedelta(minutes=history_minutes)
    retained = sorted(
        (
            item
            for item in existing_by_id.values()
            if _parse_time(item["valid_time"]) >= cutoff
        ),
        key=lambda item: _parse_time(item["valid_time"]),
    )
    keep_ids = {str(item["id"]) for item in retained}
    pruned = sorted(set(existing_by_id) - keep_ids)

    now = datetime.now(UTC)
    manifest = {
        "generated_at": now.isoformat(),
        "revision": int(now.timestamp()),
        "mode": "nexrad-n0b-base-reflectivity-archive",
        "source": "NSF Unidata national NEXRAD N0B composite",
        "product": "N0B",
        "units": "dBZ",
        "bounds": list(map(float, bounds)),
        "imageWidth": int(dbz.shape[1]),
        "imageHeight": int(dbz.shape[0]),
        "sourceGridWidth": int(gini.data.shape[1]),
        "sourceGridHeight": int(gini.data.shape[0]),
        "displayMinDbz": float(palette.TILE_DISPLAY_MIN_DBZ),
        "historyWindowMinutes": history_minutes,
        "observationCount": len(retained),
        "startTime": retained[0]["valid_time"],
        "endTime": retained[-1]["valid_time"],
        "calibration": "N0B raw 0..255 -> -32..95 dBZ",
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
            "strategy": "independent-nexrad-n0b-v2-numeric-texture",
        },
        "frames": retained,
    }
    _upload_manifest(bucket, manifest_key, manifest)

    for old_id in pruned:
        _delete_frame(bucket, prefix, old_id)

    return {
        "status": "published",
        "product": "N0B",
        "rendered": frame_id,
        "latest": source_time.isoformat(),
        "frameCount": len(retained),
        "minDbz": frame["minDbz"],
        "maxDbz": frame["maxDbz"],
        "numericRawBytes": numeric_raw_bytes,
        "numericCompressedBytes": numeric_compressed_bytes,
        "numericCompressionRatio": round(
            numeric_compressed_bytes / max(1, numeric_raw_bytes),
            4,
        ),
        "pruned": len(pruned),
    }
