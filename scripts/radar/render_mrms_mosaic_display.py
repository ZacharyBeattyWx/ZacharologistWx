#!/usr/bin/env python3
"""Production MRMS display profile for ZacharologistWx.

This module wraps the shared MRMS decoder/palette implementation and only
changes the low-reflectivity presentation used by the public mosaic. Stronger
returns keep the established ZacharologistWx palette. Weak echoes are retained
farther down the dBZ scale and drawn with a subdued gray/blue ramp so light
precipitation and clear-air texture remain visible instead of disappearing.
"""

from __future__ import annotations

import numpy as np

import render_mrms_mosaic_base as _base
from render_mrms_mosaic_base import *  # noqa: F401,F403

# Keep more of the weak-return field visible, similar to traditional NEXRAD
# mosaic presentation. Values below this remain transparent.
TILE_DISPLAY_MIN_DBZ = -10.0

_WEAK_DBZ = np.asarray([-10.0, -5.0, 0.0, 5.0, 10.0], dtype=np.float32)
_WEAK_RED = np.asarray([75, 50, 35, 40, 60], dtype=np.float32)
_WEAK_GREEN = np.asarray([75, 85, 105, 125, 145], dtype=np.float32)
_WEAK_BLUE = np.asarray([85, 125, 165, 190, 195], dtype=np.float32)

# Approximate target visibility:
# -10 dBZ 18%, -5 dBZ 28%, 0 dBZ 43%, 5 dBZ 63%,
# 10 dBZ 80%, 15 dBZ 96%. 20+ dBZ uses the normal palette alpha.
_WEAK_ALPHA_DBZ = np.asarray([-10.0, -5.0, 0.0, 5.0, 10.0, 15.0], dtype=np.float32)
_WEAK_ALPHA = np.asarray([46, 72, 110, 160, 205, 245], dtype=np.float32)


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
