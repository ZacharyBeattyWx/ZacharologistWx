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
import render_mrms_native_chunks as native_detail  # noqa: E402

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


def upload_detail_chunks(
    bucket: str,
    prefix: str,
    output_root: Path,
    manifest: dict,
) -> None:
    for chunk in manifest.get("chunks") or []:
        relative_path = str(chunk["image"])
        S3.upload_file(
            str(output_root / relative_path),
            bucket,
            object_key(prefix, relative_path),
            ExtraArgs={
                "ContentType": "image/webp",
                "CacheControl": "public,max-age=31536000,immutable",
            },
        )


def delete_object_prefix(bucket: str, prefix: str) -> int:
    deleted = 0
    continuation = None
    while True:
        request = {"Bucket": bucket, "Prefix": prefix}
        if continuation:
            request["ContinuationToken"] = continuation
        response = S3.list_objects_v2(**request)
        keys = [item["Key"] for item in response.get("Contents") or []]
        for start in range(0, len(keys), 1000):
            chunk = keys[start : start + 1000]
            S3.delete_objects(
                Bucket=bucket,
                Delete={
                    "Objects": [{"Key": key} for key in chunk],
                    "Quiet": True,
                },
            )
            deleted += len(chunk)
        if not response.get("IsTruncated"):
            break
        continuation = response.get("NextContinuationToken")
    return deleted


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


def detail_chunk_layout(manifest: dict) -> list[dict]:
    if manifest.get("mode") == "native-grid-chunk-archive":
        return list(manifest.get("chunkLayout") or [])
    keys = ("id", "bounds", "width", "height", "row", "column")
    return [
        {key: chunk[key] for key in keys if key in chunk}
        for chunk in (manifest.get("chunks") or [])
    ]


def detail_layout_id(manifest: dict) -> str | None:
    layout = detail_chunk_layout(manifest)
    if not layout:
        return None

    chunk_pixels = int(manifest.get("chunkPixels") or 0)
    rows = int(manifest.get("rows") or 0)
    columns = int(manifest.get("columns") or 0)

    return (
        f"{chunk_pixels or 'native'}:"
        f"{rows}x{columns}:"
        f"{len(layout)}"
    )


def detail_layout_descriptor(manifest: dict) -> dict | None:
    layout = detail_chunk_layout(manifest)
    if not layout:
        return None

    return {
        "chunkPixels": manifest.get("chunkPixels"),
        "rows": manifest.get("rows"),
        "columns": manifest.get("columns"),
        "chunkCount": len(layout),
        "chunkLayout": layout,
    }


def detail_frame_entry(manifest: dict) -> dict | None:
    revision = manifest.get("revision")
    valid_time = manifest.get("validTime")
    if not revision or not valid_time:
        return None

    entry = {
        "revision": str(revision),
        "validTime": valid_time,
        "sourceName": manifest.get("sourceName"),
    }

    layout_id = detail_layout_id(manifest)
    if layout_id:
        entry["layoutId"] = layout_id

    return entry


def detail_archive_frames(manifest: dict) -> list[dict]:
    if manifest.get("mode") == "native-grid-chunk-archive":
        default_layout_id = detail_layout_id(manifest)
        frames = []

        for frame in manifest.get("frames") or []:
            if not frame.get("revision") or not frame.get("validTime"):
                continue

            item = dict(frame)

            # Backfill a layout id for archive frames written before
            # per-layout metadata was introduced.
            if default_layout_id and not item.get("layoutId"):
                item["layoutId"] = default_layout_id

            frames.append(item)

        return frames

    entry = detail_frame_entry(manifest)
    return [entry] if entry and manifest.get("chunks") else []


def lambda_handler(event, context):
    bucket = os.environ["RADAR_BUCKET"]
    prefix = os.environ.get("RADAR_PREFIX", "mrms").strip("/")
    history_minutes = env_int("HISTORY_MINUTES", 24 * 60, minimum=5)
    max_width = env_int("MAX_WIDTH", 4096, minimum=512)
    max_render = env_int("MAX_RENDER_PER_RUN", 4, minimum=1)
    detail_prefix = os.environ.get("RADAR_DETAIL_PREFIX", "mrms-detail").strip("/")
    detail_chunk_pixels = env_int("DETAIL_CHUNK_PIXELS", 1024, minimum=512)
    detail_manifest_key = object_key(detail_prefix, "manifest.json")
    live_priority_count = min(
        max_render,
        env_int("LIVE_PRIORITY_COUNT", 2, minimum=1),
    )
    manifest_key = object_key(prefix, "manifest.json")

    started = time.monotonic()
    existing_manifest = load_manifest(bucket, manifest_key)
    existing_detail_manifest = load_manifest(bucket, detail_manifest_key)
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

    detail_status = "current"
    detail_error = None
    existing_detail_frames = detail_archive_frames(existing_detail_manifest)

    # Preserve every chunk layout that may still be referenced by retained
    # historical native-detail frames.
    layout_catalog = dict(
        existing_detail_manifest.get("layouts") or {}
    )

    legacy_layout_id = detail_layout_id(
        existing_detail_manifest
    )
    legacy_layout = detail_layout_descriptor(
        existing_detail_manifest
    )

    if legacy_layout_id and legacy_layout:
        layout_catalog.setdefault(
            legacy_layout_id,
            legacy_layout,
        )

    original_detail_ids = {
        str(frame["revision"]) for frame in existing_detail_frames
    }
    retained_detail = {
        str(frame["revision"]): frame
        for frame in existing_detail_frames
        if parse_iso_time(frame["validTime"]) >= cutoff
    }
    newest_source = sources[-1]
    detail_root = work_root / "native-detail"
    rendered_detail_manifest = None

    try:
        if newest_source["slug"] not in retained_detail:
            rendered_detail_manifest = native_detail.render_native_chunks(
                session,
                newest_source,
                detail_root,
                detail_chunk_pixels,
            )
            upload_detail_chunks(
                bucket,
                detail_prefix,
                detail_root,
                rendered_detail_manifest,
            )
            entry = detail_frame_entry(rendered_detail_manifest)
            if entry:
                retained_detail[entry["revision"]] = entry

            new_layout_id = detail_layout_id(
                rendered_detail_manifest
            )
            new_layout = detail_layout_descriptor(
                rendered_detail_manifest
            )

            if new_layout_id and new_layout:
                layout_catalog[new_layout_id] = new_layout

        detail_frames = sorted(
            retained_detail.values(),
            key=lambda frame: parse_iso_time(frame["validTime"]),
        )
        retained_detail_ids = {
            str(frame["revision"]) for frame in detail_frames
        }
        pruned_detail_ids = sorted(
            original_detail_ids - retained_detail_ids
        )
        needs_archive_publish = bool(
            rendered_detail_manifest
            or pruned_detail_ids
            or (
                existing_detail_frames
                and existing_detail_manifest.get("mode")
                != "native-grid-chunk-archive"
            )
        )

        geometry_source = (
            rendered_detail_manifest
            if rendered_detail_manifest
            else existing_detail_manifest
        )
        layout = detail_chunk_layout(geometry_source)

        if needs_archive_publish and detail_frames and layout:
            newest_detail = detail_frames[-1]
            archive_manifest = {
                "revision": newest_detail["revision"],
                "generatedAt": datetime.now(UTC).isoformat(),
                "mode": "native-grid-chunk-archive",
                "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
                "historyWindowMinutes": history_minutes,
                "frameCount": len(detail_frames),
                "bounds": geometry_source.get("bounds"),
                "nativeWidth": geometry_source.get("nativeWidth"),
                "nativeHeight": geometry_source.get("nativeHeight"),
                "chunkPixels": geometry_source.get("chunkPixels"),
                "rows": geometry_source.get("rows"),
                "columns": geometry_source.get("columns"),
                "chunkCount": len(layout),
                "chunkLayout": layout,
                "layouts": layout_catalog,
                "imageTemplate": (
                    "revisions/{revision}/chunks/{chunkId}.webp"
                ),
                "frames": detail_frames,
                "publisher": {
                    "platform": "aws-lambda-s3",
                    "strategy": "native-grid-chunk-archive",
                },
            }
            upload_manifest(
                bucket,
                detail_manifest_key,
                archive_manifest,
            )
            for revision_id in pruned_detail_ids:
                delete_object_prefix(
                    bucket,
                    object_key(
                        detail_prefix,
                        f"revisions/{revision_id}/",
                    ),
                )
            detail_status = "published"
            detail_revision = archive_manifest["revision"]
        elif detail_frames:
            detail_revision = detail_frames[-1]["revision"]
        else:
            detail_revision = None
    except Exception as error:
        detail_status = "error"
        detail_revision = existing_detail_manifest.get("revision")
        detail_error = str(error)
        print(f"Native MRMS detail archive failed: {error}", flush=True)

    keep_ids = {str(frame["id"]) for frame in frames}
    prune_ids = sorted(set(old_by_id) - keep_ids)

    if (
        not rendered_ids
        and not prune_ids
        and existing_manifest
        and detail_status != "published"
    ):
        latest = parse_iso_time(frames[-1]["valid_time"])
        lag_minutes = max(0.0, (datetime.now(UTC) - latest).total_seconds() / 60.0)
        return {
            "status": "no-change",
            "latest": latest.isoformat(),
            "lagMinutes": round(lag_minutes, 2),
            "nativeDetail": {
                "status": detail_status,
                "revision": detail_revision,
                "error": detail_error,
            },
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
            "nativeDetailStatus": detail_status,
            "nativeDetailRevision": detail_revision,
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
        "nativeDetail": {
            "status": detail_status,
            "revision": detail_revision,
            "error": detail_error,
        },
        "elapsedSeconds": round(time.monotonic() - started, 2),
    }
