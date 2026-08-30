#!/usr/bin/env python3
"""Fallback decoder for Unidata PNG-compressed NEX2GINI composites."""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image
from metpy.io import GiniFile
from metpy.io._tools import zlib_decompress_all_frames

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _embedded_png_payload(content: bytes) -> tuple[bytes, int]:
    """Return a byte payload containing the embedded PNG and its offset."""
    # Current national N0B files expose the PNG signature directly in the file.
    offset = content.find(PNG_SIGNATURE)
    if offset >= 0:
        return content, offset

    # Keep a zlib-expanded fallback for other GINI variants.
    expanded = bytes(zlib_decompress_all_frames(content))
    offset = expanded.find(PNG_SIGNATURE)
    if offset >= 0:
        return expanded, offset

    raise RuntimeError("No embedded PNG signature was found in the GINI payload.")


def decode_gini(content: bytes) -> GiniFile:
    """Decode a GINI file, including current PNG-compressed national composites.

    MetPy successfully parses the GINI product description, projection, and
    navigation before current Unidata PNG-compressed national composites fail at
    the final raster reshape. Preserve that partially initialized GiniFile object,
    decode the embedded PNG ourselves, and attach the decoded 8-bit raster to the
    already parsed metadata. This avoids reconstructing or patching the binary GINI
    header entirely.
    """

    decoded = GiniFile.__new__(GiniFile)
    try:
        GiniFile.__init__(decoded, BytesIO(content))
        return decoded
    except ValueError as exc:
        if "cannot reshape array" not in str(exc):
            raise

        # At this point MetPy has already populated prod_desc, proj_info and
        # prod_desc2. Those are exactly the navigation fields the renderer needs.
        if not all(hasattr(decoded, name) for name in ("prod_desc", "proj_info", "prod_desc2")):
            raise RuntimeError(
                "MetPy failed before the GINI navigation metadata was available."
            ) from exc

        payload, png_offset = _embedded_png_payload(content)
        try:
            with Image.open(BytesIO(payload[png_offset:])) as image:
                image.load()
                mode = image.mode
                if mode not in ("L", "P"):
                    raise RuntimeError(
                        f"Unexpected embedded GINI PNG mode {mode!r}; expected 8-bit L/P raster."
                    )
                raw = np.asarray(image, dtype=np.uint8)
        except Exception as png_exc:
            raise RuntimeError("Failed to decode the embedded GINI PNG raster.") from png_exc

        if raw.ndim != 2:
            raise RuntimeError(f"Embedded GINI PNG decoded to unexpected shape {raw.shape}.")

        height, width = raw.shape
        header_width = int(decoded.prod_desc.nx)
        header_height = int(decoded.prod_desc.ny)
        print(
            f"MetPy PNG fallback: expanded embedded {mode} raster "
            f"{width}x{height} from {len(content) / 1024:.1f} KiB file"
        )
        print(
            "MetPy PNG fallback navigation: "
            f"nx={header_width} ny={header_height} "
            f"projection={decoded.prod_desc.projection.name}"
        )

        if (width, height) != (header_width, header_height):
            raise RuntimeError(
                "Decoded PNG dimensions do not match the GINI navigation metadata: "
                f"PNG={width}x{height}, GINI={header_width}x{header_height}."
            )

        # Supply only the raster MetPy failed to materialize. Its parsed
        # projection/navigation methods remain intact on this same object.
        decoded.data = raw.copy()
        print(
            f"MetPy PNG fallback: attached {width}x{height} raster to parsed GINI metadata"
        )
        return decoded
