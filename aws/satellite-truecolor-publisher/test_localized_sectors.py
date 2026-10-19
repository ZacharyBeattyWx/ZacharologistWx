import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from netCDF4 import Dataset
from PIL import Image


SOURCE = Path(__file__).with_name("satellite_truecolor_publisher.py")
MODULE_SPEC = importlib.util.spec_from_file_location("localized_test_abi", SOURCE)
abi = importlib.util.module_from_spec(MODULE_SPEC)
with patch.dict(os.environ, {"RADAR_BUCKET": "test-only", "SATELLITE_TRUECOLOR_PREFIX": "satellite-truecolor"}), \
        patch("boto3.client"):
    MODULE_SPEC.loader.exec_module(abi)


class LocalizedSectorTests(unittest.TestCase):
    def test_shards_cover_catalog_once_and_keep_existing_specs(self):
        for platform, shard_count in [("East", 6), ("West", 2)]:
            specs = abi.native_localized_platform_specs(platform)
            sharded = [spec for index in range(shard_count)
                       for spec in abi.native_localized_platform_specs(platform, index, shard_count)]
            self.assertEqual(sorted(spec["sector"] for spec in specs), sorted(spec["sector"] for spec in sharded))
            self.assertLessEqual(max(len(abi.native_localized_platform_specs(platform, index, shard_count))
                                     for index in range(shard_count)), 16)
            for spec in specs:
                self.assertEqual(spec["output_width"], 2560)
                self.assertEqual(spec["c02_stride"], 1)
                self.assertEqual(spec["source_product"], "ABI-L1b-RadC")
                self.assertEqual(spec["cadence_minutes"], 5)
                self.assertEqual(spec["night_channel"], "13")
                self.assertFalse(spec["native_products"])
                self.assertTrue(spec["prefix"].startswith(f"{platform.lower()}/sectors/loc-"))
            self.assertFalse(abi.REGIONAL_PLATFORMS[platform].get("native_localized", False))
            self.assertFalse(abi.GLOBAL_PLATFORMS[platform].get("native_localized", False))
        for platform, index, count in [("bad", 0, 1), ("East", -1, 6), ("West", 2, 2), ("East", 0, 0)]:
            with self.assertRaises(ValueError):
                abi.native_localized_platform_specs(platform, index, count)

    def test_true_render_uses_sector_grid_and_raw_channels(self):
        spec = next(spec for spec in abi.native_localized_platform_specs("East")
                    if spec["sector"] == "loc-cod-NC_VA")
        group = {"time": datetime(2026, 10, 17, 17, tzinfo=timezone.utc), "scan": "20262901700", "channels": {}}
        with tempfile.TemporaryDirectory(dir=SOURCE.parent) as directory:
            cache = {}
            for channel in ["01", "02", "03", "13"]:
                path = Path(directory) / f"C{channel}.nc"
                with Dataset(path, "w") as dataset:
                    dataset.createDimension("x", 500)
                    dataset.createDimension("y", 500)
                    dataset.createVariable("x", "f8", ("x",))[:] = np.linspace(-0.06, 0.02, 500)
                    dataset.createVariable("y", "f8", ("y",))[:] = np.linspace(0.13, 0.04, 500)
                    projection = dataset.createVariable("goes_imager_projection", "i4")
                    projection.perspective_point_height = 35786023.0
                    projection.longitude_of_projection_origin = -75.2
                    projection.semi_major_axis = 6378137.0
                    projection.semi_minor_axis = 6356752.31414
                    projection.sweep_angle_axis = "x"
                    dataset.createVariable("Rad", "f4", ("y", "x"))[:] = (
                        np.linspace(0.15, 0.7, 500)[None, :] if channel != "13" else 10.0
                    )
                    for name, value in [("kappa0", 1.0), ("planck_fk1", 202263.0),
                                        ("planck_fk2", 3087.0), ("planck_bc1", 0.2), ("planck_bc2", 0.99)]:
                        dataset.createVariable(name, "f4").assignValue(value)
                group["channels"][channel] = channel
                cache[(spec["source_bucket"], channel)] = str(path)
            uploads = []
            target = SimpleNamespace(put_object=lambda **request: uploads.append(request))
            with patch.object(abi, "TARGET_S3", target), \
                    patch.object(abi, "read_reflectance", wraps=abi.read_reflectance) as reflectance, \
                    patch.object(abi, "download_source") as download:
                frame = abi.render_scan(spec, group, source_cache=cache)
                manifest = abi.publish_manifest(spec, {}, [frame], [group["scan"]], group["time"])
            download.assert_not_called()
            self.assertEqual([call.kwargs["stride"] for call in reflectance.call_args_list], [1, 1, 1])
            self.assertEqual(frame["width"], 2560)
            self.assertEqual(frame["height"], 1440)
            self.assertTrue(frame["path"].startswith("east/sectors/loc-cod-NC_VA/frames/v1/"))
            with Image.open(io.BytesIO(uploads[0]["Body"])) as image:
                self.assertEqual(image.size, (2560, 1440))
                self.assertGreater(image.convert("RGBA").getextrema()[3][1], 0)
            self.assertTrue(manifest["nativeLocalized"])
            self.assertEqual(manifest["projection"], "EPSG:3857")
            self.assertEqual(manifest["bbox"], list(spec["bbox"]))
            self.assertEqual(manifest["frameCount"], 1)
            self.assertEqual(json.loads(uploads[-1]["Body"])["frames"], [frame])
            self.assertTrue(all(Path(path).exists() for path in cache.values()))

    def test_handler_reuses_scan_discovery_and_cleans_downloads_on_failure(self):
        with tempfile.TemporaryDirectory(dir=SOURCE.parent) as directory:
            cached_path = Path(directory) / "shared.nc"
            cached_path.touch()
            caches = []
            def process(platform, spec, now, candidates, source_cache):
                caches.append(source_cache)
                source_cache["shared"] = str(cached_path)
                return {"frameCount": 1}
            with patch.object(abi, "list_complete_scans", return_value=[]) as discover, \
                    patch.object(abi, "process_platform", side_effect=process):
                result = abi.process_native_localized({"platform": "East", "shardIndex": 0, "shardCount": 6}, None)
            self.assertEqual(result["statusCode"], 200)
            self.assertEqual(len(result["results"]), 16)
            self.assertTrue(all(cache is caches[0] for cache in caches))
            discover.assert_called_once()
            self.assertFalse(cached_path.exists())
            cached_path.touch()
            def fail(platform, spec, now, candidates, source_cache):
                source_cache["shared"] = str(cached_path)
                raise RuntimeError("failed render")
            with patch.object(abi, "list_complete_scans", return_value=[]), \
                    patch.object(abi, "process_platform", side_effect=fail):
                with self.assertRaises(RuntimeError):
                    abi.process_native_localized({"platform": "West"}, None)
            self.assertFalse(cached_path.exists())

    def test_render_version_and_checked_scan_isolation(self):
        spec = abi.native_localized_platform_specs("East")[0]
        now = datetime.now(timezone.utc)
        group = {"scan": "new", "time": now, "channels": {}}
        old = {"renderVersion": 999, "checkedScans": ["new"], "frames": []}
        with patch.object(abi, "read_manifest", return_value=old), \
                patch.object(abi, "render_scan", return_value=None) as render, \
                patch.object(abi, "publish_manifest", return_value={"frameCount": 0, "frames": []}):
            abi.process_platform("East", spec, now, candidates=[group])
        render.assert_called_once()
        old["renderVersion"] = spec["render_version"]
        with patch.object(abi, "read_manifest", return_value=old), \
                patch.object(abi, "render_scan") as render, \
                patch.object(abi, "publish_manifest", return_value={"frameCount": 0, "frames": []}):
            abi.process_platform("East", spec, now, candidates=[group])
        render.assert_not_called()


if __name__ == "__main__":
    unittest.main()
