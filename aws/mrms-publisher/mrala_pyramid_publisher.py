#!/usr/bin/env python3
"""Extend the MRALA numeric publisher with a single-source resolution pyramid.

The base publisher remains responsible for downloading/decoding MRMS, maintaining
the rolling 3-hour archive, native chunks, and the legacy overview. This wrapper
adds downsampled chunk levels derived from the exact same encoded MRMS frame so
the browser can use one renderer/timeline while selecting only the resolution
needed for the current viewport.
"""

from __future__ import annotations

import os

import numpy as np

import mrala_numeric_publisher as base

S3 = base.S3


def _parse_factors() -> tuple[int, ...]:
    raw = os.environ.get("MRALA_NUMERIC_PYRAMID_FACTORS", "4,2")
    values: list[int] = []
    for item in raw.split(","):
        try:
            value = int(item.strip())
        except ValueError:
            continue
        if value > 1 and value not in values:
            values.append(value)
    values.sort(reverse=True)
    return tuple(values or [4, 2])


def _downsample_factor(encoded: np.ndarray, factor: int) -> np.ndarray:
    _, width = encoded.shape
    target_width = max(1, int(round(width / float(factor))))
    return base._downsample_nearest_uint8(encoded, target_width)


def _level_layout(
    bounds: list[float],
    width: int,
    height: int,
    chunk_pixels: int,
    factor: int,
) -> tuple[dict, list[dict]]:
    target_width = max(1, int(round(width / float(factor))))
    level_width, level_height = base._overview_shape(
        width,
        height,
        target_width,
    )
    layout, rows, columns = base._native_chunk_layout(
        bounds,
        level_width,
        level_height,
        chunk_pixels,
    )
    level_id = f"f{factor}"

    # Chunk IDs must be unique across pyramid levels because the browser's
    # native texture cache keys are frameId:chunkId.
    for chunk in layout:
        chunk["id"] = f"{level_id}-{chunk['id']}"

    spec = {
        "id": level_id,
        "factor": factor,
        "width": level_width,
        "height": level_height,
        "chunkPixels": chunk_pixels,
        "rows": rows,
        "columns": columns,
        "chunkCount": len(layout),
        "template": f"pyramid/{level_id}/{{frameId}}/{{chunkId}}.dbz",
        "layout": layout,
    }
    return spec, layout


def _native_level(
    bounds: list[float],
    width: int,
    height: int,
    chunk_pixels: int,
) -> dict:
    layout, rows, columns = base._native_chunk_layout(
        bounds,
        width,
        height,
        chunk_pixels,
    )
    return {
        "id": "f1",
        "factor": 1,
        "width": width,
        "height": height,
        "chunkPixels": chunk_pixels,
        "rows": rows,
        "columns": columns,
        "chunkCount": len(layout),
        "template": "native-chunks/{frameId}/{chunkId}.dbz",
        "layout": layout,
    }


def _upload_level(
    bucket: str,
    prefix: str,
    frame_id: str,
    encoded: np.ndarray,
    level_spec: dict,
    compresslevel: int,
) -> dict:
    raw_total = 0
    compressed_total = 0
    count = 0

    for chunk in level_spec["layout"]:
        x0 = int(chunk["x"])
        y0 = int(chunk["y"])
        width = int(chunk["width"])
        height = int(chunk["height"])
        data = np.ascontiguousarray(
            encoded[y0 : y0 + height, x0 : x0 + width],
            dtype=np.uint8,
        )
        key = (
            f"{prefix}/pyramid/{level_spec['id']}/"
            f"{frame_id}/{chunk['id']}.dbz"
        )
        raw_bytes, compressed_bytes = base._upload_numeric_grid(
            bucket,
            key,
            data,
            compresslevel,
        )
        raw_total += raw_bytes
        compressed_total += compressed_bytes
        count += 1

    return {
        "chunkCount": count,
        "rawBytes": raw_total,
        "compressedBytes": compressed_total,
    }


def _frame_ready_levels(frame: dict) -> set[str]:
    return {
        str(value)
        for value in (frame.get("pyramidLevelsReady") or [])
        if value
    }


def _delete_stale_pyramid(
    bucket: str,
    prefix: str,
    stale_ids: set[str],
    factors: tuple[int, ...],
) -> None:
    for frame_id in sorted(stale_ids):
        for factor in factors:
            base._delete_object_prefix(
                bucket,
                f"{prefix}/pyramid/f{factor}/{frame_id}/",
            )


def publish_mrala_pyramid(event: dict | None = None) -> dict:
    event = event or {}

    bucket = os.environ["RADAR_BUCKET"]
    prefix = os.environ.get(
        "MRALA_NUMERIC_PREFIX",
        "mrms-native-numeric",
    ).strip("/")
    manifest_key = f"{prefix}/manifest.json"

    factors = _parse_factors()
    chunk_pixels = base._env_int(
        "MRALA_NUMERIC_PYRAMID_CHUNK_PIXELS",
        1024,
        minimum=256,
    )
    max_pyramid_frames = base._event_int(
        event,
        "mralaPyramidMaxFrames",
        base._env_int(
            "MRALA_NUMERIC_PYRAMID_MAX_FRAMES_PER_RUN",
            8,
            minimum=1,
        ),
        minimum=1,
    )
    compresslevel = min(
        9,
        base._env_int(
            "MRALA_NUMERIC_COMPRESSLEVEL",
            4,
            minimum=1,
        ),
    )

    before = base._load_manifest(bucket, manifest_key)
    before_ids = {
        str(frame["id"])
        for frame in (before.get("frames") or [])
        if frame.get("id")
    }

    base_result = base.publish_mrala_numeric(event)

    manifest = base._load_manifest(bucket, manifest_key)
    frames = [
        dict(frame)
        for frame in (manifest.get("frames") or [])
        if frame.get("id") and frame.get("dbz")
    ]
    if not frames:
        return {
            **base_result,
            "pyramidStatus": "no-frames",
        }

    bounds = [float(value) for value in manifest["bounds"]]
    native_width = int(manifest["imageWidth"])
    native_height = int(manifest["imageHeight"])
    native_chunk_pixels = int(
        (manifest.get("nativeChunking") or {}).get("chunkPixels")
        or base._env_int("MRALA_NUMERIC_CHUNK_PIXELS", 1024, minimum=512)
    )

    level_specs: list[dict] = []
    for factor in factors:
        spec, _ = _level_layout(
            bounds,
            native_width,
            native_height,
            chunk_pixels,
            factor,
        )
        level_specs.append(spec)
    level_specs.append(
        _native_level(
            bounds,
            native_width,
            native_height,
            native_chunk_pixels,
        )
    )

    spec_by_id = {
        str(spec["id"]): spec
        for spec in level_specs
    }
    desired_level_ids = {
        f"f{factor}"
        for factor in factors
    }

    rendered_ids = {
        str(value)
        for value in (base_result.get("rendered") or [])
    }

    candidates = sorted(
        (
            frame
            for frame in frames
            if not desired_level_ids.issubset(
                _frame_ready_levels(frame)
            )
        ),
        key=lambda frame: (
            0 if str(frame["id"]) in rendered_ids else 1,
            -base._parse_iso(frame["valid_time"]).timestamp(),
        ),
    )[:max_pyramid_frames]

    upgraded: list[str] = []
    pyramid_raw = 0
    pyramid_compressed = 0

    for frame in candidates:
        frame_id = str(frame["id"])
        encoded = base._read_numeric_grid(
            bucket,
            f"{prefix}/{frame['dbz']}",
            native_width,
            native_height,
        )

        ready = _frame_ready_levels(frame)
        stats = dict(frame.get("pyramidStats") or {})

        for factor in factors:
            level_id = f"f{factor}"
            if level_id in ready:
                continue

            level_grid = _downsample_factor(
                encoded,
                factor,
            )
            level_spec = spec_by_id[level_id]
            level_stats = _upload_level(
                bucket,
                prefix,
                frame_id,
                level_grid,
                level_spec,
                compresslevel,
            )
            stats[level_id] = level_stats
            ready.add(level_id)
            pyramid_raw += int(level_stats["rawBytes"])
            pyramid_compressed += int(level_stats["compressedBytes"])

            print(
                f"Pyramid {level_id} {frame_id}: "
                f"{level_spec['width']}x{level_spec['height']} "
                f"{level_stats['chunkCount']} chunks "
                f"gzip={level_stats['compressedBytes'] / 1048576:.2f} MiB",
                flush=True,
            )

        frame["pyramidLevelsReady"] = sorted(
            ready,
            key=lambda value: int(value.removeprefix("f")),
            reverse=True,
        )
        frame["pyramidStats"] = stats
        upgraded.append(frame_id)

    frame_by_id = {
        str(frame["id"]): frame
        for frame in frames
    }

    ordered_frames = sorted(
        frame_by_id.values(),
        key=lambda frame: base._parse_iso(frame["valid_time"]),
    )

    total_frames = len(ordered_frames)
    level_availability = {}
    for factor in factors:
        level_id = f"f{factor}"
        available = sum(
            1
            for frame in ordered_frames
            if level_id in _frame_ready_levels(frame)
        )
        level_availability[level_id] = {
            "availableFrames": available,
            "totalFrames": total_frames,
            "complete": available == total_frames,
        }

    manifest["frames"] = ordered_frames
    manifest["resolutionPyramid"] = {
        "mode": "single-source-mrms-pyramid-v1",
        "source": "same encoded MRMS frame at every level",
        "levels": level_specs,
        "availability": level_availability,
        "readyForPlayback": all(
            value["complete"]
            for value in level_availability.values()
        ),
    }
    manifest.setdefault("publisher", {})
    manifest["publisher"]["pyramidStrategy"] = (
        "same-source-chunked-resolution-pyramid-v1"
    )

    base._upload_manifest(
        bucket,
        manifest_key,
        manifest,
    )

    after_ids = {
        str(frame["id"])
        for frame in ordered_frames
    }
    _delete_stale_pyramid(
        bucket,
        prefix,
        before_ids - after_ids,
        factors,
    )

    remaining = sum(
        1
        for frame in ordered_frames
        if not desired_level_ids.issubset(
            _frame_ready_levels(frame)
        )
    )

    return {
        **base_result,
        "pyramidStatus": (
            "ready"
            if remaining == 0
            else "backfilling"
        ),
        "pyramidFactors": list(factors),
        "pyramidUpgraded": upgraded,
        "pyramidRemainingFrames": remaining,
        "pyramidRawMiB": round(
            pyramid_raw / 1048576,
            2,
        ),
        "pyramidGzipMiB": round(
            pyramid_compressed / 1048576,
            2,
        ),
    }


def lambda_handler(event, context):
    return publish_mrala_pyramid(event)
