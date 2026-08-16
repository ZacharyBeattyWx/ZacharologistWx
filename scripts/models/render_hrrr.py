#!/usr/bin/env python3
"""Render a lightweight HRRR simulated-reflectivity loop for Zacharologist Wx.

The script downloads only the requested HRRR field and geographic subset through
NCEP NOMADS, renders WebP forecast frames, and writes a browser manifest.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import BoundaryNorm, ListedColormap
import numpy as np
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import xarray as xr
import cartopy.crs as ccrs
import cartopy.feature as cfeature

NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl"
USER_AGENT = "ZacharologistWx Model Renderer (https://zacharologistwx.com)"
REGION = {
    "id": "southeast",
    "label": "Southeast / Mid-Atlantic",
    "leftlon": -100.0,
    "rightlon": -72.0,
    "bottomlat": 24.0,
    "toplat": 40.5,
}

REFLECTIVITY_BOUNDS = [-10, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75]
REFLECTIVITY_COLORS = [
    "#00000000", "#6fc2ff", "#3a8fff", "#2ed7f7", "#22c55e", "#55d63b",
    "#a3e635", "#f4e64b", "#f6b73c", "#f97316", "#ef4444", "#dc2626",
    "#c026d3", "#9333ea", "#f7f7f7", "#b7ffff"
]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def filter_params(cycle: datetime, forecast_hour: int) -> dict[str, str]:
    date = cycle.strftime("%Y%m%d")
    hour = cycle.strftime("%H")
    return {
        "file": f"hrrr.t{hour}z.wrfsfcf{forecast_hour:02d}.grib2",
        "lev_entire_atmosphere": "on",
        "var_REFC": "on",
        "subregion": "",
        "leftlon": str(REGION["leftlon"]),
        "rightlon": str(REGION["rightlon"]),
        "toplat": str(REGION["toplat"]),
        "bottomlat": str(REGION["bottomlat"]),
        "dir": f"/hrrr.{date}/conus",
    }


def build_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        raise_on_status=False,
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def download_subset(session: requests.Session, cycle: datetime, forecast_hour: int, timeout: int = 120) -> bytes:
    response = session.get(NOMADS_FILTER, params=filter_params(cycle, forecast_hour), timeout=timeout)
    response.raise_for_status()
    payload = response.content
    if len(payload) < 100 or not payload.startswith(b"GRIB"):
        preview = payload[:180].decode("utf-8", errors="replace")
        raise RuntimeError(f"NOMADS did not return GRIB2 for F{forecast_hour:02d}: {preview!r}")
    return payload


def find_latest_complete_cycle(session: requests.Session, max_fh: int, lookback_hours: int = 10) -> tuple[datetime, bytes]:
    anchor = utcnow().replace(minute=0, second=0, microsecond=0)
    errors: list[str] = []
    for offset in range(lookback_hours + 1):
        cycle = anchor - timedelta(hours=offset)
        try:
            probe = download_subset(session, cycle, max_fh, timeout=75)
            return cycle, probe
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{cycle:%Y%m%d%H}: {exc}")
    raise RuntimeError("No complete HRRR cycle found. Latest attempts:\n" + "\n".join(errors[-5:]))


def open_filtered_grib(payload: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    with tempfile.TemporaryDirectory(prefix="zwx-hrrr-") as tmp:
        path = Path(tmp) / "field.grib2"
        path.write_bytes(payload)
        ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
        try:
            if not ds.data_vars:
                raise RuntimeError("Filtered HRRR GRIB has no data variables")
            var_name = next(iter(ds.data_vars))
            values = np.asarray(ds[var_name].values, dtype=np.float32).squeeze()
            lat = np.asarray(ds["latitude"].values, dtype=np.float64)
            lon = np.asarray(ds["longitude"].values, dtype=np.float64)
            lon = np.where(lon > 180.0, lon - 360.0, lon)
            if values.ndim != 2:
                raise RuntimeError(f"Expected a 2-D HRRR field, got shape {values.shape}")
            return lat, lon, values
        finally:
            ds.close()


def render_reflectivity(lat: np.ndarray, lon: np.ndarray, values: np.ndarray, cycle: datetime, fh: int, output: Path) -> None:
    valid = cycle + timedelta(hours=fh)
    cmap = ListedColormap(REFLECTIVITY_COLORS, name="zwx_reflectivity")
    norm = BoundaryNorm(REFLECTIVITY_BOUNDS, cmap.N, clip=True)

    fig = plt.figure(figsize=(12.8, 8), dpi=120, facecolor="#05090e")
    ax = plt.axes(projection=ccrs.PlateCarree())
    ax.set_facecolor("#07101a")
    ax.set_extent([REGION["leftlon"], REGION["rightlon"], REGION["bottomlat"], REGION["toplat"]], crs=ccrs.PlateCarree())

    mesh = ax.pcolormesh(lon, lat, values, cmap=cmap, norm=norm, shading="auto", transform=ccrs.PlateCarree(), rasterized=True)
    ax.add_feature(cfeature.COASTLINE.with_scale("50m"), edgecolor="#d5dfec", linewidth=0.55, zorder=5)
    ax.add_feature(cfeature.BORDERS.with_scale("50m"), edgecolor="#9fb0c6", linewidth=0.45, zorder=5)
    ax.add_feature(cfeature.STATES.with_scale("50m"), edgecolor="#788ca8", linewidth=0.38, zorder=5)

    ax.set_title(
        f"HRRR Simulated Composite Reflectivity  |  Run {cycle:%Y-%m-%d %HZ}  |  F{fh:03d}\nValid {valid:%Y-%m-%d %HZ}",
        loc="left", color="#f8fafc", fontsize=11, fontweight="bold", pad=9,
    )
    ax.text(0.995, 0.012, "Zacharologist Wx · NOAA/NCEP HRRR", transform=ax.transAxes,
            ha="right", va="bottom", color="#b8c6da", fontsize=7.5,
            bbox={"facecolor": "#05090ecc", "edgecolor": "#2a3852", "pad": 3})

    cbar = fig.colorbar(mesh, ax=ax, orientation="horizontal", pad=0.025, fraction=0.045, aspect=45)
    cbar.set_label("Composite Reflectivity (dBZ)", color="#dce6f5", fontsize=8)
    cbar.ax.tick_params(colors="#c4d0e1", labelsize=7)
    cbar.outline.set_edgecolor("#4b5d75")

    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, format="webp", dpi=120, bbox_inches="tight", facecolor=fig.get_facecolor(), pil_kwargs={"quality": 82, "method": 6})
    plt.close(fig)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", default="model-output/hrrr")
    parser.add_argument("--max-fh", type=int, default=18)
    parser.add_argument("--stride", type=int, default=1)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.max_fh < 0 or args.max_fh > 48:
        raise SystemExit("--max-fh must be between 0 and 48")
    if args.stride < 1:
        raise SystemExit("--stride must be >= 1")

    output_root = Path(args.output_root)
    product_dir = output_root / "latest" / "sim_radar_comp"
    product_dir.mkdir(parents=True, exist_ok=True)
    for old in product_dir.glob("f*.webp"):
        old.unlink()

    session = build_session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/octet-stream"})

    cycle, probe = find_latest_complete_cycle(session, args.max_fh)
    print(f"Using HRRR cycle {cycle:%Y-%m-%d %HZ}")

    frames = []
    forecast_hours = list(range(0, args.max_fh + 1, args.stride))
    for index, fh in enumerate(forecast_hours):
        print(f"Rendering HRRR F{fh:03d} ({index + 1}/{len(forecast_hours)})")
        payload = probe if fh == args.max_fh else download_subset(session, cycle, fh)
        lat, lon, values = open_filtered_grib(payload)
        output = product_dir / f"f{fh:03d}.webp"
        render_reflectivity(lat, lon, values, cycle, fh, output)
        valid = cycle + timedelta(hours=fh)
        frames.append({
            "forecastHour": fh,
            "validTime": valid.isoformat().replace("+00:00", "Z"),
            "imagePath": f"latest/sim_radar_comp/{output.name}",
        })
        time.sleep(0.35)

    manifest = {
        "schemaVersion": 1,
        "model": "HRRR",
        "modelId": "hrrr",
        "product": "sim_radar_comp",
        "productLabel": "Simulated Composite Reflectivity",
        "region": REGION,
        "run": cycle.strftime("%Y%m%d%H"),
        "runLabel": cycle.strftime("%m/%d %HZ"),
        "runTime": cycle.isoformat().replace("+00:00", "Z"),
        "updatedAt": utcnow().isoformat().replace("+00:00", "Z"),
        "source": "NOAA/NCEP HRRR via NOMADS",
        "frames": frames,
    }
    (output_root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Published {len(frames)} frames to {output_root}")


if __name__ == "__main__":
    main()
