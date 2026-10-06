import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

os.environ.update(RADAR_BUCKET="test-only", AWS_EC2_METADATA_DISABLED="true", AWS_DEFAULT_REGION="us-east-1", SATELLITE_TRUECOLOR_PREFIX="satellite-mesoscale")
sys.path.insert(0, str(Path(__file__).parent / "meso-deps"))
if not (Path(__file__).parent / "satellite_mesoscale_publisher.py").exists():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "aws/satellite-truecolor-publisher"))
import satellite_mesoscale_publisher as meso
from netCDF4 import Dataset
import numpy as np


class GeometryTests(unittest.TestCase):
    def test_completed_scans_are_not_rendered_again(self):
        now = meso.abi.utcnow()
        group = {"scan": now.strftime('%Y%j%H%M'), "time": now, "channels": {}}
        existing = {"checkedScans": [group['scan']], "frames": []}
        with patch.object(meso.abi, 'read_manifest', return_value=existing), patch.object(meso, 'list_scans', return_value=[group]), patch.object(meso.abi, 'download_source') as download:
            result = meso.process_sector('East', 'GOES-19', 'noaa-goes19', 1, now)
        self.assertEqual(result['attempted'], 0)
        download.assert_not_called()

    def test_real_coordinate_grid(self):
        path = Path(__file__).parent / "meso-test-grid.nc"
        with Dataset(path, "w") as ds:
            ds.createDimension("x", 500)
            ds.createDimension("y", 500)
            ds.createVariable("x", "f8", ("x",))[:] = np.linspace(-.032, -.004, 500)
            ds.createVariable("y", "f8", ("y",))[:] = np.linspace(.102, .074, 500)
            p = ds.createVariable("goes_imager_projection", "i4")
            p.perspective_point_height = 35786023.
            p.longitude_of_projection_origin = -75.
            p.semi_major_axis = 6378137.
            p.semi_minor_axis = 6356752.31414
            p.sweep_angle_axis = "x"
        try:
            bbox, identity = meso.scan_geometry(path)
            self.assertTrue(-110 < bbox[0] < bbox[2] < -70)
            self.assertTrue(20 < bbox[1] < bbox[3] < 50)
            self.assertEqual(len(identity), 16)
            self.assertEqual((bbox, identity), meso.scan_geometry(path))
        finally:
            path.unlink()

    def test_sector_and_budget_isolation(self):
        now = meso.abi.utcnow()
        stamp = now.strftime("%Y%j%H%M") + "000"
        keys = [{"Key": f"ABI-L1b-RadM/OR_ABI-L1b-RadM{s}-M6C{c}_G19_s{stamp}_e0_c0.nc"}
                for s in (1, 2) for c in ("01", "02", "03", "13")]
        class Pages:
            def paginate(self, **kwargs):
                return [{"Contents": keys}]
        with patch.object(meso.abi.SOURCE_S3, "get_paginator", return_value=Pages()):
            scans = meso.list_scans("unused", 2, now)
        self.assertEqual(len(scans), 1)
        self.assertTrue(all("RadM2-" in key for key in scans[0]["channels"].values()))


def live_read_only_test():
    import tempfile
    from PIL import Image
    output = Path(__file__).parent / "meso-preview"
    output.mkdir(exist_ok=True)
    objects = {}
    class Target:
        def put_object(self, **kwargs):
            objects[kwargs["Key"]] = kwargs["Body"]
            path = output / kwargs["Key"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(kwargs["Body"])
        def delete_object(self, **kwargs):
            pass
    now = meso.abi.utcnow()
    scans = meso.list_scans("noaa-goes19", 2, now)[:1]
    assert scans, "No current complete NOAA scan"
    mkstemp = tempfile.mkstemp
    def local_temp(*args, **kwargs):
        kwargs['dir'] = output
        return mkstemp(*args, **kwargs)
    with patch.object(meso.abi.tempfile, "mkstemp", side_effect=local_temp), patch.object(meso.abi, "TARGET_S3", Target()), patch.object(meso.abi, "read_manifest", return_value={}), patch.object(meso, "list_scans", return_value=scans):
        result = meso.process_sector("East", "GOES-19", "noaa-goes19", 2, now)
    for product in meso.PRODUCTS:
        manifest = json.loads(objects[f"satellite-mesoscale/east/meso-2/{product}/manifest.json"])
        frame = manifest["frames"][0]
        image = Image.open(io.BytesIO(objects[f"satellite-mesoscale/{frame['path']}"]))
        assert image.mode == "RGBA", "Missing transparent footprint"
        alpha = np.asarray(image)[..., 3]
        assert (alpha == 0).any() and (alpha > 0).any()
        if product != '02':
            assert np.std(np.asarray(image)[..., :3]) > 10, "Blank imagery"
        assert manifest["projection"] == "EPSG:3857"
    print("PASS: actual NOAA M2 scan rendered into transparent Mercator True Color, C13 and C02; no AWS writes.")
    print(json.dumps(result))


if __name__ == "__main__":
    if "--live-read-only" in sys.argv:
        live_read_only_test()
    else:
        unittest.main()
