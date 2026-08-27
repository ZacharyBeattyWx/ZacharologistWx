#!/usr/bin/env python3
"""Build an adaptive MRMS archive for 30-minute through 24-hour playback.

This keeps the newest radar history dense while progressively thinning older
observations so long loops remain practical for browsers and hosting:

- 0-60 min: every available MRMS observation
- 1-2 hr: about every 4 min
- 2-4 hr: about every 6 min
- 4-6 hr: about every 10 min
- 6-12 hr: about every 15 min
- 12-18 hr: about every 20 min
- 18-24 hr: about every 30 min

The actual radar rendering remains owned by render_mrms_loop.py and therefore
uses the same Python Level II reflectivity palette and lossless WebP output.
"""

from __future__ import annotations

import sys
from datetime import timedelta

import render_mrms_loop as base

DEFAULT_ARCHIVE_MINUTES = 24 * 60
DEFAULT_RETAIN_MINUTES = 25 * 60
_ORIGINAL_LIST_RECENT_SOURCES = base.list_recent_sources


def cadence_minutes_for_age(age_minutes: float) -> int:
    if age_minutes <= 60:
        return 0
    if age_minutes <= 120:
        return 4
    if age_minutes <= 240:
        return 6
    if age_minutes <= 360:
        return 10
    if age_minutes <= 720:
        return 15
    if age_minutes <= 1080:
        return 20
    return 30


def list_adaptive_sources(session, window_minutes: int) -> list[dict]:
    candidates = _ORIGINAL_LIST_RECENT_SOURCES(session, window_minutes)
    if len(candidates) <= 2:
        return candidates

    newest_time = candidates[-1]["filename_time"]
    selected_descending: list[dict] = []
    last_kept_time = None

    for source in reversed(candidates):
        source_time = source["filename_time"]
        age_minutes = max(0.0, (newest_time - source_time).total_seconds() / 60.0)
        cadence = cadence_minutes_for_age(age_minutes)

        keep = (
            not selected_descending
            or cadence == 0
            or last_kept_time is None
            or (last_kept_time - source_time) >= timedelta(minutes=cadence)
        )

        if keep:
            selected_descending.append(source)
            last_kept_time = source_time

    selected = list(reversed(selected_descending))

    # Preserve the oldest observation nearest the requested cutoff so the
    # timeline visually spans the complete requested history window.
    if selected[0]["slug"] != candidates[0]["slug"]:
        selected.insert(0, candidates[0])

    newest = selected[-1]["filename_time"]
    oldest = selected[0]["filename_time"]
    span = (newest - oldest).total_seconds() / 60.0
    print(
        f"Adaptive archive: {len(candidates)} source observations -> "
        f"{len(selected)} playback observations across {span:.1f} minutes",
        flush=True,
    )
    return selected


def ensure_default_argument(flag: str, value: int) -> None:
    if flag not in sys.argv:
        sys.argv.extend([flag, str(value)])


def main() -> None:
    ensure_default_argument("--minutes", DEFAULT_ARCHIVE_MINUTES)
    ensure_default_argument("--retain-minutes", DEFAULT_RETAIN_MINUTES)
    base.list_recent_sources = list_adaptive_sources
    base.main()


if __name__ == "__main__":
    main()
