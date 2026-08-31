#!/usr/bin/env python3
"""Incrementally update the rolling MRMS archive without restoring old frame blobs.

The existing manifest is the cache index. Only source observations not already in
that manifest are downloaded and rendered; existing frame images stay referenced
in the radar-data Git tree. This keeps frequent publishers lightweight while
preserving the full rolling archive and its native roughly two-minute cadence.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import requests

import render_mrms_loop as base
import render_mrms_mosaic as mrms

DEFAULT_ARCHIVE_MINUTES = 24 * 60
DEFAULT_MAX_WIDTH = 4096


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


def write_id_list(path_value: str | None, ids: list[str]) -> None:
    if not path_value:
        return
    path = Path(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(f"{frame_id}\n" for frame_id in ids), encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(base.DEFAULT_OUTPUT))
    parser.add_argument("--minutes", type=int, default=DEFAULT_ARCHIVE_MINUTES)
    parser.add_argument("--max-width", type=int, default=DEFAULT_MAX_WIDTH)
    parser.add_argument("--new-ids-file")
    parser.add_argument("--prune-ids-file")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    window_minutes = max(5, int(args.minutes))
    max_width = max(512, int(args.max_width))

    output_root = Path(args.output).resolve()
    frames_dir = output_root / "frames"
    meta_dir = output_root / "meta"
    output_root.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = output_root / "manifest.json"
    if manifest_path.exists():
        existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        existing_manifest = {}

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

    sources = base.list_recent_sources(session, window_minutes)
    newest_source_time = sources[-1]["filename_time"]
    cutoff = newest_source_time - timedelta(minutes=window_minutes)

    # Retain still-valid observations from the published manifest even if NOAA's
    # current directory listing is shorter than our requested archive window.
    retained = {
        frame_id: frame
        for frame_id, frame in old_by_id.items()
        if parse_iso_time(frame["valid_time"]) >= cutoff
    }

    rendered_payloads: list[dict] = []
    new_ids: list[str] = []

    for source in sources:
        if source["filename_time"] < cutoff:
            continue
        frame_id = source["slug"]
        if frame_id in retained:
            continue

        payload = base.render_source_frame(
            session,
            source,
            frames_dir,
            meta_dir,
            max_width,
        )
        retained[frame_id] = summarize_frame(payload)
        rendered_payloads.append(payload)
        new_ids.append(frame_id)

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
        bounds = rendered_payloads[-1]["bounds"]
        width = int(rendered_payloads[-1]["imageWidth"])
        height = int(rendered_payloads[-1]["imageHeight"])
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

    # If NOAA has not posted a new scan and nothing aged out, do not rewrite the
    # manifest just to change generated_at/revision. That avoids no-op commits.
    if not new_ids and not prune_ids and existing_manifest:
        write_id_list(args.new_ids_file, [])
        write_id_list(args.prune_ids_file, [])
        print(
            f"No archive changes; newest retained observation is {frames[-1]['valid_time']}",
            flush=True,
        )
        return

    start_time = parse_iso_time(frames[0]["valid_time"])
    end_time = parse_iso_time(frames[-1]["valid_time"])
    span_minutes = max(0.0, (end_time - start_time).total_seconds() / 60.0)

    revision = int(time.time())
    manifest = {
        "generated_at": datetime.now(UTC).isoformat(),
        "revision": revision,
        "source": "NOAA/NCEP MRMS ReflectivityAtLowestAltitude",
        "units": "dBZ",
        "bounds": bounds,
        "imageWidth": width,
        "imageHeight": height,
        "palette": str(mrms.PALETTE_FILE.relative_to(mrms.REPO_ROOT)).replace("\\", "/"),
        "displayMinDbz": mrms.TILE_DISPLAY_MIN_DBZ,
        "historyWindowMinutes": window_minutes,
        "actualSpanMinutes": round(span_minutes, 2),
        "startTime": start_time.isoformat(),
        "endTime": end_time.isoformat(),
        "observationCount": len(frames),
        "defaultFrameIntervalMs": 650,
        "frames": frames,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    write_id_list(args.new_ids_file, new_ids)
    write_id_list(args.prune_ids_file, prune_ids)

    print(
        f"Incremental MRMS update: {len(new_ids)} new, {len(prune_ids)} pruned, "
        f"{len(frames)} retained; latest={end_time.isoformat()}",
        flush=True,
    )
    print(f"Revision: {revision}", flush=True)


if __name__ == "__main__":
    main()
