#!/usr/bin/env python3
"""Serve free-pan/free-zoom hybrid NEXRAD radar tiles on demand.

This is the dynamic detail path for the ZacharologistWx NEXRAD mosaic experiment.
The browser requests ordinary Web Mercator {z}/{x}/{y} tiles. For every requested tile:

  1. Unidata's national 1-km N0B composite is sampled as the fallback.
  2. Only individual Level III N0B radar sites whose coverage intersects that tile
     are loaded.
  3. The strongest valid individual reflectivity is composited with the national value before coloring.
  4. The finished numeric dBZ tile is colorized once with the Zacharologist palette.

Nothing is tied to a named region. Panning to a new part of the CONUS simply requests
new slippy-map tiles and the relevant radar sites are selected automatically.

Local usage:
  .\\.venv-mrms\\Scripts\\python.exe .\\scripts\\radar\\serve_nexrad_detail_tiles.py

Then open nexrad-hybrid-test.html through the normal localhost:8000 static server.
"""

from __future__ import annotations

import argparse
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from io import BytesIO
import json
import math
from pathlib import Path
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import numpy as np
from PIL import Image
import requests

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

import render_mrms_mosaic as palette_renderer  # noqa: E402
import render_unidata_nexrad_mosaic as national_renderer  # noqa: E402
import render_unidata_nexrad_site_mosaic as site_renderer  # noqa: E402
from unidata_gini_decode import decode_gini  # noqa: E402

NODATA = np.float32(-9999.0)
DEFAULT_TILE_SIZE = 1024
DEFAULT_REFRESH_SECONDS = 120
DEFAULT_MIN_ZOOM = 5
DEFAULT_MAX_ZOOM = 10
DEFAULT_CACHE_TILES = 96
DEFAULT_MAX_SITES_PER_TILE = 18


def _utc_iso(value):
    if value is None:
        return None
    if getattr(value, "tzinfo", None) is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def tile_bounds(z: int, x: int, y: int):
    n = 2 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0

    def tile_lat(row):
        merc = math.pi * (1.0 - 2.0 * row / n)
        return math.degrees(math.atan(math.sinh(merc)))

    north = tile_lat(y)
    south = tile_lat(y + 1)
    return west, south, east, north


def tile_lonlat_grid(z: int, x: int, y: int, size: int):
    """Return pixel-center lon/lat grids for one Web Mercator tile."""
    world = float(size * (2 ** z))
    px = x * size + np.arange(size, dtype=np.float64) + 0.5
    py = y * size + np.arange(size, dtype=np.float64) + 0.5
    lon_axis = px / world * 360.0 - 180.0
    merc_y = math.pi * (1.0 - 2.0 * py / world)
    lat_axis = np.degrees(np.arctan(np.sinh(merc_y)))
    return np.meshgrid(lon_axis, lat_axis)


def sample_national(gini, lon_grid, lat_grid):
    """Sample the decoded national GINI directly onto a Web Mercator tile grid."""
    raw = np.asarray(gini.data)
    ny, nx = raw.shape
    proj, dx_km, dy_km = gini._get_proj_and_res()
    x0, y0 = proj(gini.prod_desc.lo1, gini.prod_desc.la1)
    dx_m = float(dx_km) * 1000.0
    dy_m = float(dy_km) * 1000.0
    top_y = y0 + (ny - 1) * dy_m

    x_grid, y_grid = proj(lon_grid, lat_grid)
    col_index = np.rint((x_grid - x0) / dx_m).astype(np.int64)
    row_index = np.rint((top_y - y_grid) / dy_m).astype(np.int64)
    valid = (
        np.isfinite(x_grid)
        & np.isfinite(y_grid)
        & (col_index >= 0)
        & (col_index < nx)
        & (row_index >= 0)
        & (row_index < ny)
    )

    raw_tile = np.zeros(lon_grid.shape, dtype=np.uint8)
    raw_tile[valid] = raw[row_index[valid], col_index[valid]]
    dbz = national_renderer.calibrate_to_dbz(raw_tile, "N0B")
    dbz[~valid] = NODATA
    return dbz


def station_distance_to_tile_km(station, bounds):
    west, south, east, north = bounds
    nearest_lon = min(max(station.lon, west), east)
    nearest_lat = min(max(station.lat, south), north)
    _, _, distance_m = site_renderer.GEOD.inv(
        station.lon, station.lat, nearest_lon, nearest_lat
    )
    return float(distance_m) / 1000.0


def sample_site_sweeps(sweeps, lon_grid, lat_grid):
    output = np.full(lon_grid.shape, NODATA, dtype=np.float32)

    west = float(np.nanmin(lon_grid))
    east = float(np.nanmax(lon_grid))
    south = float(np.nanmin(lat_grid))
    north = float(np.nanmax(lat_grid))

    for sweep in sweeps:
        lat_margin = sweep.max_range_km / 111.0
        lon_scale = max(0.2, math.cos(math.radians(sweep.lat)))
        lon_margin = sweep.max_range_km / (111.0 * lon_scale)
        if sweep.lat < south - lat_margin or sweep.lat > north + lat_margin:
            continue
        if sweep.lon < west - lon_margin or sweep.lon > east + lon_margin:
            continue

        radar_lon = np.full(lon_grid.shape, sweep.lon, dtype=np.float64)
        radar_lat = np.full(lat_grid.shape, sweep.lat, dtype=np.float64)
        forward_az, _, distance_m = site_renderer.GEOD.inv(
            radar_lon, radar_lat, lon_grid, lat_grid
        )
        distance_km = distance_m / 1000.0
        in_range = (
            np.isfinite(distance_km)
            & (distance_km >= 0.0)
            & (distance_km <= sweep.max_range_km)
        )
        if not np.any(in_range):
            continue

        bearing = np.mod(forward_az, 360.0)
        lookup_count = len(sweep.ray_lookup)
        az_bin = np.mod(
            np.rint(bearing * (lookup_count / 360.0)).astype(np.int32), lookup_count
        )
        ray_index = sweep.ray_lookup[az_bin]
        gate_count = sweep.data.shape[1]
        gate_index = np.floor(
            distance_km / max(1e-6, sweep.max_range_km) * gate_count
        ).astype(np.int32)
        gate_index = np.clip(gate_index, 0, gate_count - 1)
        sampled = sweep.data[ray_index, gate_index]
        valid = in_range & np.isfinite(sampled)
        # Reflectivity composite: retain the strongest valid return from any
        # radar that sees this pixel. A nearby blocked/attenuated radar must never
        # erase a storm that another WSR-88D sees clearly.
        empty = output <= -9000
        use = valid & (empty | (sampled > output))
        output[use] = sampled[use]

    return output


class RadarTileEngine:
    def __init__(
        self,
        tile_size=DEFAULT_TILE_SIZE,
        refresh_seconds=DEFAULT_REFRESH_SECONDS,
        cache_tiles=DEFAULT_CACHE_TILES,
        max_sites_per_tile=DEFAULT_MAX_SITES_PER_TILE,
    ):
        self.tile_size = int(tile_size)
        self.refresh_seconds = int(refresh_seconds)
        self.cache_tiles = int(cache_tiles)
        self.max_sites_per_tile = int(max_sites_per_tile)

        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": "ZacharologistWx/NEXRAD-freezoom-tile-test"}
        )

        self.station_table = site_renderer.discover_radar_stations(self.session)
        self._national = None
        self._national_source = None
        self._national_loaded_at = 0.0
        self._national_lock = threading.Lock()

        self._sweep_cache = {}
        self._sweep_loaded_at = {}
        self._site_locks = defaultdict(threading.Lock)

        self._tile_cache = OrderedDict()
        self._tile_lock = threading.Lock()
        self._stats_lock = threading.Lock()
        self.tiles_rendered = 0
        self.tile_cache_hits = 0
        self.last_error = None

        print(f"Free-zoom engine ready with {len(self.station_table)} national radar stations")

    def _bucket(self):
        return int(time.time() // max(30, self.refresh_seconds))

    def _get_national(self):
        now = time.time()
        if self._national is not None and now - self._national_loaded_at < self.refresh_seconds:
            return self._national, self._national_source

        with self._national_lock:
            now = time.time()
            if self._national is not None and now - self._national_loaded_at < self.refresh_seconds:
                return self._national, self._national_source

            source = national_renderer.discover_latest_gini(self.session, "n0b")
            response = self.session.get(source["file_url"], timeout=60)
            response.raise_for_status()
            gini = decode_gini(response.content)
            self._national = gini
            self._national_source = source
            self._national_loaded_at = time.time()
            print(f"National cache: {source['dataset_name']}")
            return gini, source

    def _get_site_sweep(self, site):
        now = time.time()
        cached = self._sweep_cache.get(site)
        loaded_at = self._sweep_loaded_at.get(site, 0.0)
        if cached is not None and now - loaded_at < self.refresh_seconds:
            return cached

        lock = self._site_locks[site]
        with lock:
            now = time.time()
            cached = self._sweep_cache.get(site)
            loaded_at = self._sweep_loaded_at.get(site, 0.0)
            if cached is not None and now - loaded_at < self.refresh_seconds:
                return cached
            sweep = site_renderer.load_site_sweep(self.session, site)
            self._sweep_cache[site] = sweep
            self._sweep_loaded_at[site] = time.time()
            return sweep

    def _candidate_sites(self, bounds, z):
        candidates = []
        for station in self.station_table.values():
            distance_km = station_distance_to_tile_km(station, bounds)
            if distance_km <= site_renderer.AUTO_SITE_RANGE_KM:
                candidates.append((distance_km, station.site))
        candidates.sort(key=lambda item: item[0])

        # Wide-view tiles cover much more geography and therefore need a larger
        # radar pool to remain a true site-derived national composite. Close-up
        # tiles can stay lean for speed because far fewer radars intersect them.
        if z <= 5:
            cap = 40
        elif z == 6:
            cap = 30
        elif z == 7:
            cap = 22
        else:
            cap = self.max_sites_per_tile
        return [site for _, site in candidates[:cap]]

    def _load_sweeps(self, sites):
        if not sites:
            return [], []
        sweeps = []
        failures = []
        workers = min(10, len(sites))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            future_map = {pool.submit(self._get_site_sweep, site): site for site in sites}
            for future in as_completed(future_map):
                site = future_map[future]
                try:
                    sweeps.append(future.result())
                except Exception as exc:
                    failures.append((site, str(exc)))
        return sweeps, failures

    def _cache_get(self, key):
        with self._tile_lock:
            value = self._tile_cache.get(key)
            if value is None:
                return None
            self._tile_cache.move_to_end(key)
            with self._stats_lock:
                self.tile_cache_hits += 1
            return value

    def _cache_put(self, key, value):
        with self._tile_lock:
            self._tile_cache[key] = value
            self._tile_cache.move_to_end(key)
            while len(self._tile_cache) > self.cache_tiles:
                self._tile_cache.popitem(last=False)

    def render_tile(self, z, x, y):
        bucket = self._bucket()
        key = (bucket, int(z), int(x), int(y), self.tile_size)
        cached = self._cache_get(key)
        if cached is not None:
            return cached

        bounds = tile_bounds(z, x, y)
        lon_grid, lat_grid = tile_lonlat_grid(z, x, y, self.tile_size)

        gini, national_source = self._get_national()
        national_dbz = sample_national(gini, lon_grid, lat_grid)

        candidate_sites = self._candidate_sites(bounds, z)
        sweeps, failures = self._load_sweeps(candidate_sites)
        site_dbz = sample_site_sweeps(sweeps, lon_grid, lat_grid)
        site_valid = np.isfinite(site_dbz) & (site_dbz > -9000)

        # Site data is the primary high-resolution surface. The national 1-km
        # mosaic is used only where no individual N0B site provides a valid sample.
        # This prevents coarse 1-km blocks from surviving inside otherwise sharp
        # detail tiles. sample_site_sweeps() already composites the strongest valid
        # return from the expanded surrounding-radar pool.
        combined = np.array(national_dbz, copy=True)
        combined[site_valid] = site_dbz[site_valid]
        rgba = palette_renderer.colorize_dbz_grid_for_tiles(combined)

        buffer = BytesIO()
        Image.fromarray(rgba, mode="RGBA").save(
            buffer, "WEBP", lossless=True, method=4
        )
        payload = buffer.getvalue()

        meta = {
            "z": z,
            "x": x,
            "y": y,
            "bounds": [round(v, 5) for v in bounds],
            "candidateSites": candidate_sites,
            "workingSites": sorted(s.site for s in sweeps),
            "failures": failures,
            "nativeReplacementPercent": round(
                100.0 * float(np.count_nonzero(site_valid)) / site_valid.size, 2
            ),
            "nationalDataset": national_source.get("dataset_name"),
            "bytes": len(payload),
        }
        result = (payload, meta)
        self._cache_put(key, result)
        with self._stats_lock:
            self.tiles_rendered += 1
        print(
            f"tile {z}/{x}/{y} | sites={len(sweeps)}/{len(candidate_sites)} "
            f"native={meta['nativeReplacementPercent']:.1f}% | {len(payload)/1024:.0f} KiB"
        )
        return result

    def status(self):
        source = self._national_source or {}
        with self._stats_lock:
            rendered = self.tiles_rendered
            hits = self.tile_cache_hits
        return {
            "ok": True,
            "mode": "all-zoom site-derived NEXRAD slippy pyramid",
            "tileSize": self.tile_size,
            "refreshSeconds": self.refresh_seconds,
            "stationCount": len(self.station_table),
            "cachedSites": len(self._sweep_cache),
            "cachedTiles": len(self._tile_cache),
            "tilesRendered": rendered,
            "tileCacheHits": hits,
            "nationalDataset": source.get("dataset_name"),
            "nationalTimestamp": _utc_iso(source.get("timestamp")),
            "lastError": self.last_error,
        }


def make_handler(engine, min_zoom, max_zoom):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ZwxNexradTile/0.1"

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path

            if path in ("/", "/status", "/status.json"):
                payload = json.dumps(engine.status(), indent=2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self._cors()
                self.end_headers()
                self.wfile.write(payload)
                return

            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[0] == "tiles" and parts[3].endswith(".webp"):
                try:
                    z = int(parts[1])
                    x = int(parts[2])
                    y = int(parts[3][:-5])
                    n = 2 ** z
                    if z < min_zoom or z > max_zoom or x < 0 or y < 0 or x >= n or y >= n:
                        raise ValueError("tile outside supported range")
                    payload, meta = engine.render_tile(z, x, y)
                except ValueError as exc:
                    print(f"404 TILE {path}: {exc}")
                    self.send_error(404, str(exc))
                    return
                except Exception as exc:
                    engine.last_error = str(exc)
                    print(f"ERROR {path}: {exc}")
                    self.send_error(500, str(exc))
                    return

                self.send_response(200)
                self.send_header("Content-Type", "image/webp")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "public, max-age=60")
                self.send_header("X-Zwx-Radar-Sites", ",".join(meta["workingSites"]))
                self.send_header(
                    "X-Zwx-Native-Replacement", str(meta["nativeReplacementPercent"])
                )
                self._cors()
                self.end_headers()
                self.wfile.write(payload)
                return

            self.send_error(404, "Unknown endpoint")

        def log_message(self, fmt, *args):
            if args and str(args[1]) == "200":
                return
            super().log_message(fmt, *args)

    return Handler


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--refresh-seconds", type=int, default=DEFAULT_REFRESH_SECONDS)
    parser.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM)
    parser.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM)
    parser.add_argument("--cache-tiles", type=int, default=DEFAULT_CACHE_TILES)
    parser.add_argument("--max-sites-per-tile", type=int, default=DEFAULT_MAX_SITES_PER_TILE)
    return parser.parse_args()


def main():
    args = parse_args()
    engine = RadarTileEngine(
        tile_size=args.tile_size,
        refresh_seconds=args.refresh_seconds,
        cache_tiles=args.cache_tiles,
        max_sites_per_tile=args.max_sites_per_tile,
    )
    handler = make_handler(engine, args.min_zoom, args.max_zoom)
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(
        f"NEXRAD detail tile server listening on http://{args.bind}:{args.port}\n"
        f"Tiles: /tiles/{{z}}/{{x}}/{{y}}.webp | status: /status.json\n"
        "Keep this terminal open while testing nexrad-hybrid-test.html."
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping tile server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
