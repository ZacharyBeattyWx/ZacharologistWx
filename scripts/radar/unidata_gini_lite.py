#!/usr/bin/env python3
"""Lightweight decoder for Unidata PNG-compressed NEX2GINI composites.

This intentionally implements only the navigation fields used by the national
NEXRAD mosaic renderer. It avoids importing MetPy/Xarray/SciPy in the Lambda
image while retaining the same ``data``, ``prod_desc`` and
``_get_proj_and_res()`` interface the renderer already expects.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import IntEnum
from io import BytesIO
import re
import struct
import zlib

import numpy as np
from PIL import Image
import pyproj

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
WMO_HEADER_RE = re.compile(rb"T\w{3}\d{2}[^\r\n]*\r\r\n")
EARTH_RADIUS_M = 6_371_200.0


class GiniProjection(IntEnum):
    mercator = 1
    lambert_conformal = 3
    polar_stereographic = 5


def _scaled_int(raw: bytes) -> float:
    if len(raw) != 3:
        raise ValueError(f"Expected 3-byte GINI scaled integer, got {len(raw)}")
    sign = -1 if (raw[0] & 0x80) else 1
    magnitude = ((raw[0] & 0x7F) << 16) | (raw[1] << 8) | raw[2]
    return sign * magnitude / 10000.0


def _decode_datetime(raw: bytes) -> datetime:
    if len(raw) != 7:
        raise ValueError(f"Expected 7-byte GINI datetime, got {len(raw)}")
    year, month, day, hour, minute, second, centisecond = raw
    year += 1900 if year >= 70 else 2000
    return datetime(year, month, day, hour, minute, second, centisecond * 10_000)


def _strip_wmo_header(data: bytes) -> bytes:
    probe = data[:128]
    match = WMO_HEADER_RE.search(probe)
    return data[match.end():] if match else data


def _zlib_decompress_all_frames(data: bytes) -> bytes:
    frames = bytearray()
    remaining = bytes(data)
    while remaining:
        decoder = zlib.decompressobj()
        try:
            frames.extend(decoder.decompress(remaining))
        except zlib.error:
            frames.extend(remaining)
            break
        unused = decoder.unused_data
        if not unused or unused == remaining:
            break
        remaining = unused
    return bytes(frames)


@dataclass(frozen=True)
class ProductDescription:
    source: int
    creating_entity: int
    sector_id: int
    channel: int
    num_records: int
    record_len: int
    datetime: datetime
    projection: GiniProjection
    nx: int
    ny: int
    la1: float
    lo1: float


@dataclass(frozen=True)
class LambertPolarInfo:
    reserved: int
    lov: float
    dx: float
    dy: float
    proj_center: int


@dataclass(frozen=True)
class MercatorInfo:
    resolution: int
    la2: float
    lo2: float
    di: int
    dj: int


@dataclass(frozen=True)
class ProductDescription2:
    scanning_mode: int
    lat_in: float
    resolution: int
    compression: int
    version: int
    pdb_size: int
    nav_cal: int


class GiniFileLite:
    def __init__(self, prod_desc, proj_info, prod_desc2, data: np.ndarray):
        self.prod_desc = prod_desc
        self.proj_info = proj_info
        self.prod_desc2 = prod_desc2
        self.data = data

    def __str__(self) -> str:
        return (
            "GiniFileLite: "
            f"time={self.prod_desc.datetime.isoformat()} "
            f"size={self.prod_desc.nx}x{self.prod_desc.ny} "
            f"projection={self.prod_desc.projection.name} "
            f"ll=({self.prod_desc.lo1:.4f},{self.prod_desc.la1:.4f})"
        )

    def _get_proj_and_res(self):
        kwargs = {"a": EARTH_RADIUS_M, "b": EARTH_RADIUS_M}
        projection = self.prod_desc.projection

        if projection == GiniProjection.lambert_conformal:
            kwargs.update(
                proj="lcc",
                lat_0=self.prod_desc2.lat_in,
                lon_0=self.proj_info.lov,
                lat_1=self.prod_desc2.lat_in,
                lat_2=self.prod_desc2.lat_in,
            )
            dx_km = float(self.proj_info.dx)
            dy_km = float(self.proj_info.dy)
        elif projection == GiniProjection.polar_stereographic:
            kwargs.update(
                proj="stere",
                lon_0=self.proj_info.lov,
                lat_0=-90 if self.proj_info.proj_center else 90,
                lat_ts=60.0,
                x_0=0.0,
                y_0=0.0,
            )
            dx_km = float(self.proj_info.dx)
            dy_km = float(self.proj_info.dy)
        elif projection == GiniProjection.mercator:
            kwargs.update(
                proj="merc",
                lat_0=self.prod_desc.la1,
                lon_0=self.prod_desc.lo1,
                lat_ts=self.prod_desc2.lat_in,
            )
            dx_km = float(self.proj_info.di)
            dy_km = float(self.proj_info.dj)
        else:
            raise RuntimeError(f"Unsupported GINI projection {projection}")

        return pyproj.Proj(**kwargs), dx_km, dy_km


def _parse_navigation(content: bytes):
    binary = _strip_wmo_header(content)
    expanded = _zlib_decompress_all_frames(binary)
    expanded = _strip_wmo_header(expanded)

    start_fmt = struct.Struct(">bbbbHH7sbHH3s3s")
    if len(expanded) < start_fmt.size:
        raise RuntimeError("GINI payload is too short to contain a product description")

    (
        source,
        creating_entity,
        sector_id,
        channel,
        num_records,
        record_len,
        raw_time,
        projection_value,
        nx,
        ny,
        raw_la1,
        raw_lo1,
    ) = start_fmt.unpack_from(expanded, 0)

    try:
        projection = GiniProjection(projection_value)
    except ValueError as exc:
        raise RuntimeError(f"Unsupported GINI projection code {projection_value}") from exc

    prod_desc = ProductDescription(
        source=source,
        creating_entity=creating_entity,
        sector_id=sector_id,
        channel=channel,
        num_records=num_records,
        record_len=record_len,
        datetime=_decode_datetime(raw_time),
        projection=projection,
        nx=nx,
        ny=ny,
        la1=_scaled_int(raw_la1),
        lo1=_scaled_int(raw_lo1),
    )

    offset = start_fmt.size
    if projection in (GiniProjection.lambert_conformal, GiniProjection.polar_stereographic):
        proj_fmt = struct.Struct(">b3s3s3sb")
        reserved, raw_lov, raw_dx, raw_dy, proj_center = proj_fmt.unpack_from(expanded, offset)
        proj_info = LambertPolarInfo(
            reserved=reserved,
            lov=_scaled_int(raw_lov),
            dx=_scaled_int(raw_dx),
            dy=_scaled_int(raw_dy),
            proj_center=proj_center,
        )
    else:
        proj_fmt = struct.Struct(">b3s3sHH")
        resolution, raw_la2, raw_lo2, di, dj = proj_fmt.unpack_from(expanded, offset)
        proj_info = MercatorInfo(
            resolution=resolution,
            la2=_scaled_int(raw_la2),
            lo2=_scaled_int(raw_lo2),
            di=di,
            dj=dj,
        )
    offset += proj_fmt.size

    end_fmt = struct.Struct(">b3sbbbHb")
    scanning_mode, raw_lat_in, resolution, compression, version, pdb_size, nav_cal = end_fmt.unpack_from(expanded, offset)
    prod_desc2 = ProductDescription2(
        scanning_mode=scanning_mode,
        lat_in=_scaled_int(raw_lat_in),
        resolution=resolution,
        compression=compression,
        version=version,
        pdb_size=pdb_size,
        nav_cal=nav_cal,
    )
    return prod_desc, proj_info, prod_desc2, expanded


def _decode_embedded_png(content: bytes, expanded: bytes) -> tuple[np.ndarray, str]:
    for payload in (content, expanded):
        offset = payload.find(PNG_SIGNATURE)
        if offset < 0:
            continue
        with Image.open(BytesIO(payload[offset:])) as image:
            image.load()
            mode = image.mode
            if mode not in ("L", "P"):
                raise RuntimeError(
                    f"Unexpected embedded GINI PNG mode {mode!r}; expected 8-bit L/P raster"
                )
            raw = np.asarray(image, dtype=np.uint8)
        if raw.ndim != 2:
            raise RuntimeError(f"Embedded GINI PNG decoded to unexpected shape {raw.shape}")
        return raw.copy(), mode
    raise RuntimeError("No embedded PNG signature was found in the GINI payload")


def decode_gini(content: bytes) -> GiniFileLite:
    """Decode the navigation and embedded 8-bit raster from a national GINI file."""
    prod_desc, proj_info, prod_desc2, expanded = _parse_navigation(content)
    raw, mode = _decode_embedded_png(content, expanded)

    height, width = raw.shape
    if (width, height) != (int(prod_desc.nx), int(prod_desc.ny)):
        raise RuntimeError(
            "Decoded PNG dimensions do not match GINI navigation metadata: "
            f"PNG={width}x{height}, GINI={prod_desc.nx}x{prod_desc.ny}"
        )

    print(
        f"GINI-lite: decoded embedded {mode} raster {width}x{height} "
        f"from {len(content) / 1024:.1f} KiB file"
    )
    print(
        "GINI-lite navigation: "
        f"projection={prod_desc.projection.name} "
        f"origin={prod_desc.lo1:.4f},{prod_desc.la1:.4f}"
    )
    return GiniFileLite(prod_desc, proj_info, prod_desc2, raw)
