"""Isolated color tests; no AWS credentials or scientific IO libraries needed."""
import ast
import math
import os
import unittest
from pathlib import Path

import numpy as np


TREE = ast.parse(Path(__file__).with_name("satellite_truecolor_publisher.py").read_text())
FUNCTIONS = {"truecolor_limb_dehaze"}


def reference_mercator_bounds(bbox):
    west, south, east, north = bbox
    radius = 6378137.0
    return (radius * math.radians(west),
            radius * math.log(math.tan(math.pi / 4 + math.radians(south) / 2)),
            radius * math.radians(east),
            radius * math.log(math.tan(math.pi / 4 + math.radians(north) / 2)))


SCOPE = {"np": np, "math": math, "mercator_bounds": reference_mercator_bounds}
exec(compile(ast.Module(body=[n for n in TREE.body if isinstance(n, ast.FunctionDef)
                             and n.name in FUNCTIONS], type_ignores=[]),
             "<publisher-color-tests>", "exec"), SCOPE)
DEHAZE = SCOPE["truecolor_limb_dehaze"]


class TrueColorDehazeTests(unittest.TestCase):
    def setUp(self):
        self.spec = {"bbox": (-107, 23.5, -87.5, 39.5),
                     "subsatellite_longitude": -75.2,
                     "dehaze_floor": 0.035, "dehaze_strength": 0.06}
        self.rgb = np.full((12, 16, 3), 0.4, dtype=np.float32)
        self.finite = np.ones((12, 16), dtype=bool)

    def test_texas_veil_reduced(self):
        old = DEHAZE(self.rgb, self.finite, dict(self.spec, dehaze_floor=0))
        new = DEHAZE(self.rgb, self.finite, self.spec)
        self.assertTrue(np.all(new <= old))
        self.assertLess(float(new[6, 8, 0]), float(old[6, 8, 0]) - 0.01)
        self.assertGreater(float(new.min()), 0.35)

    def test_white_and_black_preserved(self):
        for value in (0.0, 1.0):
            rgb = np.full_like(self.rgb, value)
            np.testing.assert_array_equal(DEHAZE(rgb, self.finite, self.spec), rgb)

    def test_invalid_and_dtype(self):
        self.finite[0, 0] = False
        result = DEHAZE(self.rgb, self.finite, self.spec)
        np.testing.assert_array_equal(result[0, 0], [0, 0, 0])
        self.assertEqual(result.dtype, np.float32)
        self.assertTrue(np.all(np.isfinite(result)))

    def test_off_is_exact_identity(self):
        self.assertIs(DEHAZE(self.rgb, self.finite, {"bbox": self.spec["bbox"]}), self.rgb)

    def test_extreme_settings_bounded(self):
        for floor, strength in [(-1, -1), (10, 10)]:
            result = DEHAZE(self.rgb, self.finite,
                            dict(self.spec, dehaze_floor=floor, dehaze_strength=strength))
            self.assertTrue(np.all((result >= 0) & (result <= 1)))

    def test_west_geometry(self):
        spec = dict(self.spec, subsatellite_longitude=-137.2,
                    bbox=(-128, 23, -99.5, 43))
        result = DEHAZE(self.rgb, self.finite, spec)
        self.assertTrue(np.all(result < self.rgb))

    def test_all_regional_and_localized_specs_inherit_floor(self):
        names = {"REGIONAL_PLATFORMS", "LOCALIZED_SECTORS"}
        selected = [n for n in TREE.body
                    if isinstance(n, ast.Assign) and any(
                        isinstance(t, ast.Name) and t.id in names for t in n.targets)]
        selected.extend(n for n in TREE.body if isinstance(n, ast.FunctionDef)
                        and n.name in {"localized_platform_specs", "output_width_for_resolution"})
        scope = dict(SCOPE, os=os, MAX_RENDER_PER_PLATFORM=2,
                     TRUECOLOR_DEHAZE_FLOOR=0.035, LOCALIZED_RENDER_VERSION=7,
                     LOCALIZED_MAX_RENDER_PER_SECTOR=2, LOCALIZED_DEHAZE_STRENGTH=0.06)
        exec(compile(ast.Module(body=selected, type_ignores=[]), "<sector-specs>", "exec"), scope)
        for platform, base in scope["REGIONAL_PLATFORMS"].items():
            self.assertEqual(base["dehaze_floor"], 0.035)
            self.assertEqual(base["render_version"], 15)
            for spec in scope["localized_platform_specs"](platform, base):
                self.assertEqual(spec["dehaze_floor"], 0.035)
                self.assertEqual(spec["render_version"], 7)

    def test_legacy_limb_formula_unchanged(self):
        spec = dict(self.spec, dehaze_floor=0)
        result = DEHAZE(self.rgb, self.finite, spec)
        # Reverse the neutral-veil transform; without a floor it stays <= 0.06.
        veil = (0.4 - result[..., 0]) / (1 - result[..., 0])
        self.assertTrue(np.all((veil >= 0) & (veil <= 0.060001)))
        west, south, east, north = spec["bbox"]
        _, ymin, _, ymax = reference_mercator_bounds(spec["bbox"])
        lats = 2 * np.arctan(np.exp(np.linspace(ymax, ymin, 12) / 6378137.0)) - np.pi / 2
        lons = np.radians(np.linspace(west, east, 16))
        cosine = np.cos(lats)[:, None] * np.cos(lons - math.radians(-75.2))[None, :]
        limb = np.clip((0.82 - cosine) / 0.32, 0, 1)
        old_veil = 0.06 * limb * limb * (3 - 2 * limb)
        expected = ((self.rgb - old_veil[..., None]) / (1 - old_veil[..., None])).astype(np.float32)
        np.testing.assert_array_equal(result, expected)


if __name__ == "__main__":
    unittest.main()
