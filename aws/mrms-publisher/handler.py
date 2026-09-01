#!/usr/bin/env python3
"""AWS Lambda worker for publishing the rolling MRMS radar archive to S3.

Freshness is the primary goal. When the archive is behind, this worker renders the
newest missing MRMS scans first so the public feed can recover immediately, then
uses any remaining per-run capacity to backfill older gaps.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import boto3
import requests
from botocore.exceptions import ClientError

RADAR_SCRIPT_DIR = Path(__file__).resolve().parent / "scripts" / "radar"
sys.path.insert(0, str(RADAR_SCRIPT_DIR))

import render_mrms_loop as base  # noqa: E402
import render_mrms_mosaic as mrms  # noqa: E402

S3 = boto3.client("s3")


def env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, value)


def parse_iso_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def summarize_frame(frame: dict) -> dict:
    return {
        key: frame[key]
        for key in ("id", "valid_time", "image", "source_name", "minDbz", "maxDbz")
    }


def object_key(prefix: str, relative_path: str) -> str:
    prefix = prefix.strip("/")
    relative_path = relative_path.lstrip("/")
    return f"{prefix}/{relative_path}" if prefix else relative_path


def load_manifest(bucket: str, manifest_key: str) -> dict:
    try:
        response = S3.get_object(Bucket=bucket, Key=manifest_key)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        if code in {"NoSuchKey", "NoSuchBucket", "404"}:
            if code == "NoSuchBucket":
                raise
            return {}
        raise
    return json.loads(response["Body"].read().decode("utf-8"))


def select_work(
    missing_sources: list[dict],
    retained_count: int,
    max_render: int,
    live_priority_count: int,
) -> list[dict]:
    """Choose newest scans first and grow history backward from the live edge."""
    if not missing_sources:
        return []

    newest_first = list(reversed(missing_sources))

    # On a brand-new archive, publish a small current loop first instead of a
    # sparse 24-hour manifest containing frames from opposite ends of the day.
    if retained_count == 0:
        return newest_first[:max_render]

    selected: list[dict] = []
    selected_ids: set[str] = set()

    for source in newest_first[: min(live_priority_count, max_render)]:
        selected.append(source)
        selected_ids.add(source["slug"])

    # Spend the rest of the invocation on the next-newest missing observations.
    # That grows one continuous recent loop backward instead of creating a sparse
    # manifest with jumps to the oldest missing scans in the 24-hour window.
    for source in newest_first:
        if len(selected) >= max_render:
            break
        if source["slug"] in selected_ids:
            continue
        selected.append(source)
        selected_ids.add(source["slug"])

    return selected


def upload_frame(bucket: str, prefix: str, image_path: Path, frame_id: str) -> None:
    S3.upload_file(
        str(image_path),
        bucket,
        object_key(prefix, f"frames/{frame_id}.webp"),
        ExtraArgs={
            "ContentType": "image/webp",
            "CacheControl": "public,max-age=31536000,immutable",
        },
    )


def upload_manifest(bucket: str, manifest_key: str, manifest: dict) -> None:
    S3.put_object(
        Bucket=bucket,
        Key=manifest_key,
        Body=json.dumps(manifest, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-cache,max-age=0,must-revalidate",
    )


def delete_pruned_frames(bucket: str, prefix: str, frame_ids: list[str]) -> None:
    if not frame_ids:
        return
    for start in range(0, len(frame_ids), 1000):
        chunk = frame_ids[start : start + 1000]
        S3.delete_objects(
            Bucket=bucket,
            Delete={
                "Objects": [
                    {"Key": object_key(prefix, f"frames/{frame_id}.webp")}
                    for frame_id in chunk
                ],
                "Quiet": True,
            },
        )


def lambda_handler(event, context):
    bucket = os.environ["RADAR_BUCKET"]
    prefix = os.environ.get("RADAR_PREFIX", "mrms").strip("/")
    history_minutes = env_int("HISTORY_MINUTES", 24 * 60, minimum=5)
    max_width = env_int("MAX_WIDTH", 4096, minimum=512)
    max_render = env_int("MAX_RENDER_PER_RUN", 4, minimum=1)
    live_priority_count = min(
        max_render,
        env_int("LIVE_PRIORITY_COUNT", 2, minimum=1),
    )
    manifest_key = object_key(prefix, "manifest.json")

    started = time.monotonic()
    existing_manifest = load_manifest(bucket, manifest_key)
    old_frames = existing_manifest.get("frames") or []
    old_by_id = {
        str(frame["id"]): frame
        for frame in old_frames
        if frame.get("id") and frame.get("valid_time")
    }

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": mrms.USER_AGENT,
            "Accept": "*/*",
            "Cache-Control": "no-cache",
        }
    )

    sources = base.list_recent_sources(session, history_minutes)
    newest_source_time = sources[-1]["filename_time"]
    cutoff = newest_source_time - timedelta(minutes=history_minutes)

    retained = {
        frame_id: frame
        for frame_id, frame in old_by_id.items()
        if parse_iso_time(frame["valid_time"]) >= cutoff
    }

    missing_sources = [
        source
        for source in sources
        if source["filename_time"] >= cutoff and source["slug"] not in retained
    ]
    selected_sources = select_work(
        missing_sources,
        len(retained),
        max_render,
        live_priority_count,
    )

    work_root = Path("/tmp/mrms-publisher")
    frames_dir = work_root / "frames"
    meta_dir = work_root / "meta"
    frames_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    rendered_payloads: list[dict] = []
    rendered_ids: list[str] = []

    # selected_sources is deliberately ordered newest-first for the live-priority
    # portion. If Lambda approaches its timeout, the freshest frames are already
    # the ones most likely to have completed.
    for source in selected_sources:
        payload = base.render_source_frame(
            session,
            source,
            frames_dir,
            meta_dir,
            max_width,
        )
        upload_frame(bucket, prefix, frames_dir / f"{source['slug']}.webp", source["slug"])
        retained[source["slug"]] = summarize_frame(payload)
        rendered_payloads.append(payload)
        rendered_ids.append(source["slug"])

    frames = sorted(
        retained.values(),
        key=lambda frame: parse_iso_time(frame["valid_time"]),
    )
    if len(frames) < 2:
        raise RuntimeError("Fewer than two MRMS observations are available for the archive")

    if existing_manifest.get("bounds"):
        bounds = existing_manifest["bounds"]
        width = int(existing_manifest["imageWidth"])
        height = int(existing_manifest["imageHeight"])
    elif rendered_payloads:
        bounds = rendered_payloads[0]["bounds"]
        width = int(rendered_payloads[0]["imageWidth"])
        height = int(rendered_payloads[0]["imageHeight"])
    else:
        raise RuntimeError("Archive geometry is unavailable")

    for payload in rendered_payloads:
        if (
            payload.get("bounds") != bounds
            or int(payload.get("imageWidth", 0)) != width
            or int(payload.get("imageHeight", 0)) != height
        ):
            raise RuntimeError(
                f"MRMS geometry changed for {payload.get('id')}; full archive rebuild required"
            )

    keep_ids = {str(frame["id"]) for frame in frames}
    prune_ids = sorted(set(old_by_id) - keep_ids)

    if not rendered_ids and not prune_ids and existing_manifest:
        latest = parse_iso_time(frames[-1]["valid_time"])
        lag_minutes = max(0.0, (datetime.now(UTC) - latest).total_seconds() / 60.0)
        return {
            "status": "no-change",
            "latest": latest.isoformat(),
            "lagMinutes": round(lag_minutes, 2),
            "elapsedSeconds": round(time.monotonic() - started, 2),
        }

    start_time = parse_iso_time(frames[0]["valid_time"])
    end_time = parse_iso_time(frames[-1]["valid_time"])
    span_minutes = max(0.0, (end_time - start_time).total_seconds() / 60.0)
    now = datetime.now(UTC)
    lag_minutes = max(0.0, (now - end_time).total_seconds() / 60.0)
    revision = int(time.time())

    manifest = {
        "generated_at": now.isoformat(),
        "revision": revision,
        "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
        "units": "dBZ",
        "bounds": bounds,
        "imageWidth": width,
        "imageHeight": height,
        "palette": "scripts/radar/palettes/zacharologist-reflectivity.pal",
        "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
        "historyWindowMinutes": history_minutes,
        "actualSpanMinutes": round(span_minutes, 2),
        "startTime": start_time.isoformat(),
        "endTime": end_time.isoformat(),
        "observationCount": len(frames),
        "defaultFrameIntervalMs": 650,
        "publisher": {
            "platform": "aws-lambda-s3",
            "lagMinutesAtPublish": round(lag_minutes, 2),
            "renderedThisRun": len(rendered_ids),
            "missingAfterRun": max(0, len(missing_sources) - len(rendered_ids)),
        },
        "frames": frames,
    }

    # New images are uploaded first; the manifest is the atomic publication step.
    upload_manifest(bucket, manifest_key, manifest)

    # Only remove expired objects after the new manifest no longer references them.
    delete_pruned_frames(bucket, prefix, prune_ids)

    return {
        "status": "published",
        "rendered": rendered_ids,
        "pruned": len(prune_ids),
        "observations": len(frames),
        "latest": end_time.isoformat(),
        "lagMinutes": round(lag_minutes, 2),
        "remainingMissing": max(0, len(missing_sources) - len(rendered_ids)),
        "elapsedSeconds": round(time.monotonic() - started, 2),
    }
