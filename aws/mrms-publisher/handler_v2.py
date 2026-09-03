#!/usr/bin/env python3
"""Paired MRMS publisher for ZacharologistWx.

The public timeline is transactional: an observation is not exposed in the base
manifest until both its overview texture and native-detail chunks exist. Each
new or repaired observation is downloaded/decoded once, then rendered into both
products from the same numeric MRMS grid.

The legacy /mrms/manifest.json and /mrms-detail/manifest.json endpoints remain
compatible with the current browser while carrying a stricter 1:1 frame set.
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
import render_mrms_frame_bundle as frame_bundle  # noqa: E402

S3 = boto3.client("s3")


def env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, value)


def parse_iso_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def object_key(prefix: str, relative_path: str) -> str:
    prefix = prefix.strip("/")
    relative_path = relative_path.lstrip("/")
    return f"{prefix}/{relative_path}" if prefix else relative_path


def load_manifest(bucket: str, manifest_key: str) -> dict:
    try:
        response = S3.get_object(Bucket=bucket, Key=manifest_key)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        if code in {"NoSuchKey", "404"}:
            return {}
        raise
    return json.loads(response["Body"].read().decode("utf-8"))


def upload_manifest(bucket: str, manifest_key: str, manifest: dict) -> None:
    S3.put_object(
        Bucket=bucket,
        Key=manifest_key,
        Body=json.dumps(manifest, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-cache,max-age=0,must-revalidate",
    )


def upload_overview(
    bucket: str,
    prefix: str,
    image_path: Path,
    frame_id: str,
) -> None:
    S3.upload_file(
        str(image_path),
        bucket,
        object_key(prefix, f"frames/{frame_id}.webp"),
        ExtraArgs={
            "ContentType": "image/webp",
            "CacheControl": "public,max-age=31536000,immutable",
        },
    )


def upload_detail_chunks(
    bucket: str,
    detail_prefix: str,
    native_root: Path,
    detail_manifest: dict,
) -> None:
    for chunk in detail_manifest.get("chunks") or []:
        relative_path = str(chunk["image"])
        S3.upload_file(
            str(native_root / relative_path),
            bucket,
            object_key(detail_prefix, relative_path),
            ExtraArgs={
                "ContentType": "image/webp",
                "CacheControl": "public,max-age=31536000,immutable",
            },
        )


def delete_base_frames(bucket: str, prefix: str, frame_ids: list[str]) -> None:
    if not frame_ids:
        return
    for start in range(0, len(frame_ids), 1000):
        chunk = frame_ids[start : start + 1000]
        S3.delete_objects(
            Bucket=bucket,
            Delete={
                "Objects": [
                    {
                        "Key": object_key(
                            prefix,
                            f"frames/{frame_id}.webp",
                        )
                    }
                    for frame_id in chunk
                ],
                "Quiet": True,
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


def select_work(
    missing_sources: list[dict],
    paired_count: int,
    max_render: int,
    live_priority_count: int,
) -> list[dict]:
    """Repair newest observations first, then grow paired history backward."""
    if not missing_sources:
        return []

    newest_first = list(reversed(missing_sources))
    if paired_count == 0:
        return newest_first[:max_render]

    selected: list[dict] = []
    selected_ids: set[str] = set()

    for source in newest_first[: min(live_priority_count, max_render)]:
        selected.append(source)
        selected_ids.add(source["slug"])

    for source in newest_first:
        if len(selected) >= max_render:
            break
        if source["slug"] in selected_ids:
            continue
        selected.append(source)
        selected_ids.add(source["slug"])

    return selected


def overview_frame(payload: dict) -> dict:
    return {
        key: payload[key]
        for key in (
            "id",
            "valid_time",
            "image",
            "source_name",
            "minDbz",
            "maxDbz",
            "detailRevision",
        )
    }


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
            if default_layout_id and not item.get("layoutId"):
                item["layoutId"] = default_layout_id
            frames.append(item)
        return frames

    entry = detail_frame_entry(manifest)
    return [entry] if entry and manifest.get("chunks") else []


def _same_bounds(left, right) -> bool:
    if not left or not right or len(left) != len(right):
        return False
    return all(
        abs(float(a) - float(b)) < 1e-7
        for a, b in zip(left, right)
    )


def lambda_handler(event, context):
    bucket = os.environ["RADAR_BUCKET"]
    prefix = os.environ.get("RADAR_PREFIX", "mrms").strip("/")
    detail_prefix = os.environ.get(
        "RADAR_DETAIL_PREFIX",
        "mrms-detail",
    ).strip("/")

    history_minutes = env_int(
        "HISTORY_MINUTES",
        24 * 60,
        minimum=5,
    )
    max_width = env_int("MAX_WIDTH", 4096, minimum=512)
    max_render = env_int(
        "MAX_RENDER_PER_RUN",
        4,
        minimum=1,
    )
    detail_chunk_pixels = env_int(
        "DETAIL_CHUNK_PIXELS",
        1024,
        minimum=512,
    )
    live_priority_count = min(
        max_render,
        env_int("LIVE_PRIORITY_COUNT", 2, minimum=1),
    )

    manifest_key = object_key(prefix, "manifest.json")
    detail_manifest_key = object_key(
        detail_prefix,
        "manifest.json",
    )

    started = time.monotonic()
    existing_manifest = load_manifest(bucket, manifest_key)
    existing_detail_manifest = load_manifest(
        bucket,
        detail_manifest_key,
    )

    old_base_frames = existing_manifest.get("frames") or []
    old_base_by_id = {
        str(frame["id"]): dict(frame)
        for frame in old_base_frames
        if frame.get("id") and frame.get("valid_time")
    }

    old_detail_frames = detail_archive_frames(
        existing_detail_manifest
    )
    old_detail_by_id = {
        str(frame["revision"]): dict(frame)
        for frame in old_detail_frames
        if frame.get("revision") and frame.get("validTime")
    }

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": mrms.USER_AGENT,
            "Accept": "*/*",
            "Cache-Control": "no-cache",
        }
    )

    sources = base.list_recent_sources(
        session,
        history_minutes,
    )
    newest_source_time = sources[-1]["filename_time"]
    cutoff = newest_source_time - timedelta(
        minutes=history_minutes
    )

    retained_base = {
        frame_id: frame
        for frame_id, frame in old_base_by_id.items()
        if parse_iso_time(frame["valid_time"]) >= cutoff
    }
    retained_detail = {
        frame_id: frame
        for frame_id, frame in old_detail_by_id.items()
        if parse_iso_time(frame["validTime"]) >= cutoff
    }

    paired_before = set(retained_base) & set(retained_detail)
    missing_sources = [
        source
        for source in sources
        if (
            source["slug"] not in retained_base
            or source["slug"] not in retained_detail
        )
    ]
    selected_sources = select_work(
        missing_sources,
        len(paired_before),
        max_render,
        live_priority_count,
    )

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

    work_root = Path("/tmp/mrms-publisher-v2")
    work_root.mkdir(parents=True, exist_ok=True)

    rendered_ids: list[str] = []
    newest_detail_manifest = None
    overview_bounds = existing_manifest.get("bounds")
    overview_width = int(
        existing_manifest.get("imageWidth") or 0
    )
    overview_height = int(
        existing_manifest.get("imageHeight") or 0
    )

    expected_detail_bounds = (
        existing_detail_manifest.get("bounds")
        if existing_detail_manifest
        else None
    )
    expected_native_width = int(
        existing_detail_manifest.get("nativeWidth") or 0
    )
    expected_native_height = int(
        existing_detail_manifest.get("nativeHeight") or 0
    )

    for source in selected_sources:
        bundle = frame_bundle.render_frame_bundle(
            session,
            source,
            work_root,
            max_width=max_width,
            chunk_pixels=detail_chunk_pixels,
        )

        if overview_bounds:
            if (
                not _same_bounds(
                    bundle["bounds"],
                    overview_bounds,
                )
                or bundle["overview_width"] != overview_width
                or bundle["overview_height"] != overview_height
            ):
                raise RuntimeError(
                    f"MRMS overview geometry changed for {source['slug']}; "
                    "full archive rebuild required"
                )
        else:
            overview_bounds = bundle["bounds"]
            overview_width = bundle["overview_width"]
            overview_height = bundle["overview_height"]

        detail_manifest = bundle["detail"]
        if expected_detail_bounds:
            if (
                not _same_bounds(
                    detail_manifest.get("bounds"),
                    expected_detail_bounds,
                )
                or int(detail_manifest.get("nativeWidth") or 0)
                != expected_native_width
                or int(detail_manifest.get("nativeHeight") or 0)
                != expected_native_height
            ):
                raise RuntimeError(
                    f"MRMS native geometry changed for {source['slug']}; "
                    "full archive rebuild required"
                )
        else:
            expected_detail_bounds = detail_manifest.get(
                "bounds"
            )
            expected_native_width = int(
                detail_manifest.get("nativeWidth") or 0
            )
            expected_native_height = int(
                detail_manifest.get("nativeHeight") or 0
            )

        # Assets are written first. Neither public manifest is advanced until
        # BOTH overview and detail uploads for the observation have succeeded.
        upload_overview(
            bucket,
            prefix,
            bundle["overview_path"],
            source["slug"],
        )
        upload_detail_chunks(
            bucket,
            detail_prefix,
            bundle["native_root"],
            detail_manifest,
        )

        retained_base[source["slug"]] = overview_frame(
            bundle["overview"]
        )
        entry = detail_frame_entry(detail_manifest)
        if not entry:
            raise RuntimeError(
                f"Native detail metadata missing for {source['slug']}"
            )
        retained_detail[source["slug"]] = entry

        layout_id = detail_layout_id(detail_manifest)
        layout = detail_layout_descriptor(
            detail_manifest
        )
        if layout_id and layout:
            layout_catalog[layout_id] = layout

        newest_detail_manifest = detail_manifest
        rendered_ids.append(source["slug"])

    paired_ids = set(retained_base) & set(retained_detail)

    frames = sorted(
        (
            {
                **retained_base[frame_id],
                "detailRevision": frame_id,
            }
            for frame_id in paired_ids
        ),
        key=lambda frame: parse_iso_time(
            frame["valid_time"]
        ),
    )
    detail_frames = sorted(
        (
            retained_detail[frame_id]
            for frame_id in paired_ids
        ),
        key=lambda frame: parse_iso_time(
            frame["validTime"]
        ),
    )

    if len(frames) < 2 or len(detail_frames) < 2:
        raise RuntimeError(
            "Fewer than two paired MRMS observations are available; "
            "leaving the previous public manifests untouched"
        )

    if newest_detail_manifest:
        geometry_source = newest_detail_manifest
    else:
        geometry_source = existing_detail_manifest

    layout = detail_chunk_layout(geometry_source)
    if not layout:
        raise RuntimeError(
            "Native detail layout unavailable"
        )

    newest_detail = detail_frames[-1]
    now = datetime.now(UTC)
    start_time = parse_iso_time(frames[0]["valid_time"])
    end_time = parse_iso_time(frames[-1]["valid_time"])
    span_minutes = max(
        0.0,
        (end_time - start_time).total_seconds() / 60.0,
    )
    lag_minutes = max(
        0.0,
        (now - end_time).total_seconds() / 60.0,
    )

    detail_archive_manifest = {
        "revision": newest_detail["revision"],
        "generatedAt": now.isoformat(),
        "mode": "native-grid-chunk-archive",
        "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
        "historyWindowMinutes": history_minutes,
        "frameCount": len(detail_frames),
        "bounds": geometry_source.get("bounds"),
        "nativeWidth": geometry_source.get(
            "nativeWidth"
        ),
        "nativeHeight": geometry_source.get(
            "nativeHeight"
        ),
        "chunkPixels": geometry_source.get(
            "chunkPixels"
        ),
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
            "strategy": "paired-transactional-v2",
        },
    }

    revision = int(time.time())
    manifest = {
        "generated_at": now.isoformat(),
        "revision": revision,
        "mode": "paired-overview-native-archive",
        "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
        "units": "dBZ",
        "bounds": overview_bounds,
        "imageWidth": overview_width,
        "imageHeight": overview_height,
        "palette": (
            "scripts/radar/palettes/"
            "zacharologist-reflectivity.pal"
        ),
        "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
        "historyWindowMinutes": history_minutes,
        "actualSpanMinutes": round(
            span_minutes,
            2,
        ),
        "startTime": start_time.isoformat(),
        "endTime": end_time.isoformat(),
        "observationCount": len(frames),
        "defaultFrameIntervalMs": 650,
        "nativeDetailManifest": (
            "../mrms-detail/manifest.json"
        ),
        "publisher": {
            "platform": "aws-lambda-s3",
            "strategy": "paired-transactional-v2",
            "lagMinutesAtPublish": round(
                lag_minutes,
                2,
            ),
            "renderedThisRun": len(
                rendered_ids
            ),
            "missingAfterRun": max(
                0,
                len(missing_sources)
                - len(rendered_ids),
            ),
            "pairedObservations": len(frames),
        },
        "frames": frames,
    }

    # Critical ordering:
    # 1. every immutable asset has already uploaded;
    # 2. publish the detail archive;
    # 3. publish the base timeline LAST.
    #
    # A client that observes a new base frame can therefore expect that its
    # native-detail metadata and chunk objects were already published.
    upload_manifest(
        bucket,
        detail_manifest_key,
        detail_archive_manifest,
    )
    upload_manifest(
        bucket,
        manifest_key,
        manifest,
    )

    keep_ids = {str(frame["id"]) for frame in frames}
    old_base_ids = set(old_base_by_id)
    old_detail_ids = set(old_detail_by_id)
    prune_base_ids = sorted(old_base_ids - keep_ids)
    prune_detail_ids = sorted(
        old_detail_ids - keep_ids
    )

    delete_base_frames(
        bucket,
        prefix,
        prune_base_ids,
    )
    for frame_id in prune_detail_ids:
        delete_object_prefix(
            bucket,
            object_key(
                detail_prefix,
                f"revisions/{frame_id}/",
            ),
        )

    final_pair_ids = set(keep_ids)
    remaining_missing = sum(
        1
        for source in sources
        if source["slug"] not in final_pair_ids
    )

    return {
        "status": (
            "published"
            if rendered_ids
            or prune_base_ids
            or prune_detail_ids
            else "no-change"
        ),
        "strategy": "paired-transactional-v2",
        "rendered": rendered_ids,
        "prunedBase": len(prune_base_ids),
        "prunedDetail": len(prune_detail_ids),
        "observations": len(frames),
        "latest": end_time.isoformat(),
        "lagMinutes": round(
            lag_minutes,
            2,
        ),
        "remainingMissing": remaining_missing,
        "paired": True,
        "elapsedSeconds": round(
            time.monotonic() - started,
            2,
        ),
    }
