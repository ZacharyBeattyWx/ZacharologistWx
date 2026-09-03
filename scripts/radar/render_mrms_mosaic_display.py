#!/usr/bin/env python3
"""Production MRMS display profile for ZacharologistWx.

This module wraps the shared MRMS decoder/palette implementation and only
changes the low-reflectivity presentation used by the public mosaic. Stronger
returns keep the established ZacharologistWx palette. Weak echoes are retained
well into negative dBZ and drawn with a subdued gray/blue ramp so light
precipitation and clear-air texture remain visible instead of disappearing.
"""

from __future__ import annotations

import numpy as np

import render_mrms_mosaic_base as _base
from render_mrms_mosaic_base import *  # noqa: F401,F403

# Traditional mosaic products can display very weak negative-dBZ returns.
# Keep the field down to -30 dBZ; the shared decoder already preserves values
# to -32 dBZ, so this is presentation-only and does not alter the source data.
TILE_DISPLAY_MIN_DBZ = -30.0

_WEAK_DBZ = np.asarray(
    [-30.0, -25.0, -20.0, -15.0, -10.0, -5.0, 0.0, 5.0, 10.0],
    dtype=np.float32,
)
_WEAK_RED = np.asarray(
    [72, 88, 105, 118, 92, 66, 45, 38, 56],
    dtype=np.float32,
)
_WEAK_GREEN = np.asarray(
    [72, 82, 94, 105, 112, 122, 135, 150, 165],
    dtype=np.float32,
)
_WEAK_BLUE = np.asarray(
    [78, 92, 108, 124, 142, 162, 184, 202, 205],
    dtype=np.float32,
)

# Negative returns are deliberately visible rather than merely nonzero. The
# low end stays muted gray/blue, then ramps smoothly into the normal palette.
_WEAK_ALPHA_DBZ = np.asarray(
    [-30.0, -25.0, -20.0, -15.0, -10.0, -5.0, 0.0, 5.0, 10.0, 15.0],
    dtype=np.float32,
)
_WEAK_ALPHA = np.asarray(
    [48, 58, 72, 88, 108, 132, 158, 185, 215, 245],
    dtype=np.float32,
)


def colorize_dbz_grid_for_tiles(grid: np.ndarray, nodata: float = NODATA) -> np.ndarray:
    sampled = np.asarray(grid, dtype=np.float32)

    # Start from the shared color table so stronger returns remain unchanged.
    rgba = _base.colorize_dbz_grid(sampled, nodata)
    valid = np.isfinite(sampled) & (sampled != nodata)

    rgba[..., 3][valid & (sampled < TILE_DISPLAY_MIN_DBZ)] = 0

    weak_color = valid & (sampled >= TILE_DISPLAY_MIN_DBZ) & (sampled < 10.0)
    if np.any(weak_color):
        values = sampled[weak_color]
        rgba[..., 0][weak_color] = np.clip(
            np.interp(values, _WEAK_DBZ, _WEAK_RED), 0, 255
        ).astype(np.uint8)
        rgba[..., 1][weak_color] = np.clip(
            np.interp(values, _WEAK_DBZ, _WEAK_GREEN), 0, 255
        ).astype(np.uint8)
        rgba[..., 2][weak_color] = np.clip(
            np.interp(values, _WEAK_DBZ, _WEAK_BLUE), 0, 255
        ).astype(np.uint8)

    weak_alpha = valid & (sampled >= TILE_DISPLAY_MIN_DBZ) & (sampled < 20.0)
    if np.any(weak_alpha):
        values = sampled[weak_alpha]
        rgba[..., 3][weak_alpha] = np.clip(
            np.interp(values, _WEAK_ALPHA_DBZ, _WEAK_ALPHA), 0, 255
        ).astype(np.uint8)

    black_with_alpha = (
        (rgba[..., 0] < 8)
        & (rgba[..., 1] < 8)
        & (rgba[..., 2] < 8)
        & (rgba[..., 3] > 0)
    )
    rgba[..., 3][black_with_alpha] = 0
    return rgba
