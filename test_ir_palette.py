"""Numeric palette and isolated publisher-migration tests; no AWS calls."""
import ast
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "satellite_truecolor_publisher.py"
MESO = ROOT / "satellite_mesoscale_publisher.py"
if not SOURCE.exists():
    SOURCE = ROOT / "aws/satellite-truecolor-publisher/satellite_truecolor_publisher.py"
    MESO = SOURCE.with_name("satellite_mesoscale_publisher.py")


def isolated(path, names, scope):
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    nodes = [node for node in tree.body if
             isinstance(node, ast.FunctionDef) and node.name in names or
             isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets)]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), scope)
    return scope


PALETTE = isolated(SOURCE, {"clean_ir_rgb", "CLEAN_IR_PALETTE_ID", "NATIVE_RENDER_VERSIONS"}, {"np": np})


class PaletteTests(unittest.TestCase):
    def test_anchor_temperatures(self):
        temperatures = np.array([180, 193, 200, 210, 213, 226, 235, 240, 245, 300], dtype=float)
        original = temperatures.copy()
        rgb, valid = PALETTE["clean_ir_rgb"](temperatures)
        np.testing.assert_allclose(rgb, [[1,1,1],[0,0,0],[1,0,0],[1,.45,0],
                                       [1,1,0],[0,1,0],[0,.25,1],[.6,0,1],[1,1,1],[0,0,0]], atol=1e-6)
        np.testing.assert_array_equal(temperatures, original)
        self.assertTrue(valid.all())

    def test_range_shape_and_invalid_pixels(self):
        temperatures = np.array([[np.nan, np.inf, -np.inf], [170, 320, 195]])
        rgb, valid = PALETTE["clean_ir_rgb"](temperatures)
        self.assertEqual(rgb.shape, (2,3,3))
        np.testing.assert_array_equal(valid[0], [False,False,False])
        self.assertTrue((rgb[0] == 0).all())
        self.assertTrue(np.isfinite(rgb).all())
        self.assertTrue(((rgb >= 0) & (rgb <= 1)).all())
        np.testing.assert_array_equal(rgb[1,0], [1,1,1])
        np.testing.assert_array_equal(rgb[1,1], [0,0,0])
        self.assertLess(rgb[1,2].max(), .3, "195 K core should be dark, not bright red")

    def test_only_ir_version_changes(self):
        self.assertEqual(PALETTE["NATIVE_RENDER_VERSIONS"],
                         {"clean-ir":6,"air-mass":2,"simple-water-vapor":2,"day-cloud-phase":3})


class MigrationTests(unittest.TestCase):
    def setup_publisher(self, success=True, current=False):
        now = datetime(2026,10,8,1,tzinfo=timezone.utc)
        iso = lambda time: time.isoformat().replace("+00:00", "Z")
        groups = [{"scan":str(i),"time":now-timedelta(minutes=i),"channels":
                   {channel:f"{i}-{channel}.nc" for channel in ["01","02","03","13"]}} for i in [1,2,3]]
        manifests = {}
        for product in ["true-color","13","02"]:
            version = 3 if current and product == "13" else 1
            manifests[product] = {"renderVersion":version,"checkedScans":[g["scan"] for g in groups],
                "frames":[{"scan":g["scan"],"time":iso(g["time"]),"geometry":"same",
                           "path":f"east/meso-1/{product}/frames/v{version}/{g['scan']}.webp"} for g in groups]}
        writes, deletes, rendered, events = [], [], [], []
        class Target:
            def put_object(self, **kwargs):
                writes.append(json.loads(kwargs["Body"]))
                events.append(("put", writes[-1]["product"]))
            def delete_object(self, **kwargs):
                deletes.append(kwargs["Key"])
                events.append(("delete", kwargs["Key"]))
        abi = SimpleNamespace(read_manifest=lambda spec:manifests[spec["prefix"].split("/")[-1]],
            download_source=lambda *args:args[1],TARGET_S3=Target(),TARGET_BUCKET="test-only",
            TARGET_PREFIX="satellite-mesoscale",datetime=datetime,iso_z=iso,
            manifest_key=lambda spec:f"satellite-mesoscale/{spec['prefix']}/manifest.json",
            CLEAN_IR_PALETTE_ID=PALETTE["CLEAN_IR_PALETTE_ID"])
        def render(spec, group, path, product):
            rendered.append((product,spec["render_version"],group["scan"]))
            if not success:
                return None
            return {"scan":group["scan"],"time":iso(group["time"]),
                    "path":f"{spec['prefix']}/frames/v{spec['render_version']}/{group['scan']}.webp"}
        scope = {"abi":abi,"timedelta":timedelta,"json":json,
                 "os":SimpleNamespace(getenv=lambda name,default:default,unlink=lambda path:None),
                 "list_scans":lambda *args:groups,"scan_geometry":lambda path:([-95,25,-85,35],"same"),
                 "render_band":render}
        isolated(MESO, {"process_sector","PRODUCTS","MAX_HISTORY_FRAMES","HISTORY_WINDOW_MINUTES"}, scope)
        result = scope["process_sector"]("East","GOES-19","unused",1,now)
        return result,writes,deletes,rendered,events

    def test_new_palette_rebuild_is_ir_only_and_bounded(self):
        result,writes,deletes,rendered,events = self.setup_publisher()
        self.assertEqual(result["attempted"],2)
        self.assertEqual(rendered,[("13",3,"1"),("13",3,"2")])
        ir = next(m for m in writes if m["product"] == "13")
        self.assertEqual(ir["renderVersion"],3)
        self.assertEqual(ir["recipe"]["palette"],PALETTE["CLEAN_IR_PALETTE_ID"])
        self.assertTrue(all("/13/frames/v3/" in f["path"] for f in ir["frames"]))
        self.assertEqual(len(ir["frames"]),2)
        for product in ["true-color","02"]:
            manifest = next(m for m in writes if m["product"] == product)
            self.assertEqual(len(manifest["frames"]),3)
            self.assertTrue(all("/v1/" in f["path"] for f in manifest["frames"]))
        self.assertEqual(len(deletes),3)
        self.assertTrue(all("/13/frames/v1/" in key for key in deletes))
        self.assertLess(events.index(("put","13")),next(i for i,event in enumerate(events) if event[0] == "delete"))

    def test_failed_render_keeps_previous_ir_manifest_and_images(self):
        _,writes,deletes,_,_ = self.setup_publisher(success=False)
        self.assertFalse(any(m["product"] == "13" for m in writes))
        self.assertFalse(deletes)

    def test_current_version_is_not_rendered_again(self):
        result,_,deletes,rendered,_ = self.setup_publisher(current=True)
        self.assertEqual(result["attempted"],0)
        self.assertFalse(rendered)
        self.assertFalse(deletes)


def preview():
    from PIL import Image, ImageDraw, ImageFont
    temperatures = np.linspace(180,315,1200)
    rgb,_ = PALETTE["clean_ir_rgb"](temperatures)
    image = Image.new("RGB", (1280,270), "#101820")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 22)
    draw.text((40,20),"Proposed Clean IR enhancement (temperature mapping, not a storm image)",font=font,fill="white")
    band = Image.fromarray(np.repeat((rgb[None,:,:]*255).astype(np.uint8),90,axis=0))
    image.paste(band,(40,80))
    for temperature in [180,193,200,213,226,240,258,280,300,315]:
        x = 40+(temperature-180)/135*1199
        draw.line((x,170,x,182),fill="white",width=1)
        draw.text((x,190),str(temperature),font=font,fill="white",anchor="mt")
    draw.text((40,230),"Kelvin: colder on the left; warmer on the right. COD-style, not an exact published COD table.",font=font,fill="#bfd2e1")
    image.save(ROOT / "clean-ir-palette-preview.png")


if __name__ == "__main__":
    import sys
    if "--preview" in sys.argv:
        preview()
    else:
        unittest.main()
