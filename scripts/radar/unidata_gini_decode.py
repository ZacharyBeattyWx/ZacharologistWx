#!/usr/bin/env python3
"""Fallback decoder for Unidata PNG-compressed NEX2GINI composites."""

from __future__ import annotations

from io import BytesIO
import re

import numpy as np
from PIL import Image
from metpy.io import GiniFile
from metpy.io._tools import zlib_decompress_all_frames

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
WMO_FINDER = re.compile(rb"(T\w{3}\d{2})[\s\w\d]+\w*(\w{3})\r\r\n")


def _find_pdb_offset(payload: bytes) -> int:
    """Return the Product Description Block start after any WMO headers."""
    offset = 0
    # GiniFile may encounter a WMO header before and/or after compression. For
    # the already-expanded fallback payload, walk past any header that begins
    # within the next 64 bytes just like MetPy does.
    for _ in range(2):
        window = payload[offset:offset + 64]
        match = WMO_FINDER.search(window)
        if not match:
            break
        offset += match.end()
    return offset


def _normalize_record_count(prefix: bytes, width: int, height: int) -> bytes:
    """Make GINI num_records agree with the decoded PNG raster height.

    Current Unidata national N0B GINI files advertise one more record than the
    image height (for example num_records=3001 while ny=3000). MetPy 1.x uses
    num_records to decide how many raster bytes to read, then reshapes to ny/nx,
    which produces exactly one extra row and fails. Normalize only after
    validating the neighboring header fields against the decoded PNG.
    """
    pdb = _find_pdb_offset(prefix)
    if len(prefix) < pdb + 20:
        raise RuntimeError("GINI Product Description Block is too short to normalize.")

    current_records = int.from_bytes(prefix[pdb + 4:pdb + 6], "big")
    record_len = int.from_bytes(prefix[pdb + 6:pdb + 8], "big")
    nx = int.from_bytes(prefix[pdb + 16:pdb + 18], "big")
    ny = int.from_bytes(prefix[pdb + 18:pdb + 20], "big")

    print(
        "MetPy PNG fallback header: "
        f"num_records={current_records} record_len={record_len} nx={nx} ny={ny}"
    )

    if nx != width or ny != height:
        raise RuntimeError(
            "Decoded PNG dimensions do not match GINI navigation header: "
            f"PNG={width}x{height}, header={nx}x{ny}."
        )
    if record_len != width:
        raise RuntimeError(
            f"Unexpected GINI record length {record_len}; expected decoded width {width}."
        )

    if current_records == height:
        return prefix
    if current_records != height + 1:
        raise RuntimeError(
            f"Unexpected GINI num_records={current_records}; expected {height} or {height + 1}."
        )

    patched = bytearray(prefix)
    patched[pdb + 4:pdb + 6] = int(height).to_bytes(2, "big")
    print(f"MetPy PNG fallback: normalized num_records {current_records} -> {height}")
    return bytes(patched)


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
        # First normalize num_records because current national composites count
        # one additional record even though ny is the actual PNG raster height.
        prefix = _normalize_record_count(expanded[:png_offset], width, height)
        marker = (b"\xff\x00" * (width // 2)) + (b"\xff" if width % 2 else b"")
        synthetic = prefix + raw.tobytes(order="C") + marker

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

        print(f"MetPy PNG fallback: reconstructed {width}x{height} GINI raster successfully")
        return decoded
