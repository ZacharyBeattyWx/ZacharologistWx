#!/usr/bin/env python3
"""Fallback decoder for Unidata PNG-compressed NEX2GINI composites."""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image
from metpy.io import GiniFile
from metpy.io._tools import zlib_decompress_all_frames

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def decode_gini(content: bytes) -> GiniFile:
    """Decode a GINI file, including current PNG-compressed national composites.

    MetPy 1.x can parse the navigation/PDB for these products but currently tries
    to reshape the compressed PNG byte stream as if it were the raw raster. When
    that happens, expand the embedded PNG to its original 8-bit raster and feed a
    synthetic uncompressed GINI payload back through MetPy so all projection and
    navigation handling still comes from MetPy.
    """

    try:
        return GiniFile(BytesIO(content))
    except ValueError as exc:
        message = str(exc)
        if "cannot reshape array" not in message:
            raise

        expanded = bytes(zlib_decompress_all_frames(content))
        png_offset = expanded.find(PNG_SIGNATURE)
        if png_offset < 0:
            raise RuntimeError(
                "MetPy could not reshape the GINI raster and no embedded PNG "
                "signature was found after zlib expansion."
            ) from exc

        with Image.open(BytesIO(expanded[png_offset:])) as image:
            image.load()
            mode = image.mode
            if mode not in ("L", "P"):
                raise RuntimeError(
                    f"Unexpected embedded GINI PNG mode {mode!r}; expected 8-bit L/P raster."
                ) from exc
            raw = np.asarray(image, dtype=np.uint8)

        if raw.ndim != 2:
            raise RuntimeError(f"Embedded GINI PNG decoded to unexpected shape {raw.shape}.") from exc

        height, width = raw.shape
        print(
            f"MetPy PNG fallback: expanded embedded {mode} raster "
            f"{width}x{height} from {len(expanded) / 1024:.1f} KiB payload"
        )

        # GINI's normal uncompressed raster is followed by one EOF record made of
        # alternating FF/00 bytes. Recreate that layout after the original PDB.
        marker = (b"\xff\x00" * (width // 2)) + (b"\xff" if width % 2 else b"")
        synthetic = expanded[:png_offset] + raw.tobytes(order="C") + marker

        try:
            decoded = GiniFile(BytesIO(synthetic))
        except Exception as synthetic_exc:
            raise RuntimeError(
                "Embedded PNG was decoded successfully, but reconstructing the "
                "uncompressed GINI payload failed."
            ) from synthetic_exc

        if decoded.data.shape != raw.shape:
            raise RuntimeError(
                f"Reconstructed GINI raster shape {decoded.data.shape} does not match "
                f"embedded PNG shape {raw.shape}."
            )

        return decoded
