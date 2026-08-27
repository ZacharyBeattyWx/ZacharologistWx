#!/usr/bin/env python3
"""Build a full-cadence MRMS archive for 30-minute through 24-hour playback.

Every available NOAA MRMS ReflectivityAtLowestAltitude observation is retained
through the requested history window. MRMS observations are normally about two
minutes apart, so playback speed stays visually consistent from the oldest
frame through Now instead of changing in segments.

The actual radar rendering remains owned by render_mrms_loop.py and therefore
uses the same Python Level II reflectivity palette and lossless WebP output.
"""

from __future__ import annotations

import sys

import render_mrms_loop as base

DEFAULT_ARCHIVE_MINUTES = 24 * 60
DEFAULT_RETAIN_MINUTES = 25 * 60


def ensure_default_argument(flag: str, value: int) -> None:
    if flag not in sys.argv:
        sys.argv.extend([flag, str(value)])


def main() -> None:
    ensure_default_argument("--minutes", DEFAULT_ARCHIVE_MINUTES)
    ensure_default_argument("--retain-minutes", DEFAULT_RETAIN_MINUTES)
    base.main()


if __name__ == "__main__":
    main()
