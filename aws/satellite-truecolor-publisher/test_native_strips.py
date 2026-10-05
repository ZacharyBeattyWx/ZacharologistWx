import ast
import io
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image

source = Path(__file__).with_name('satellite_truecolor_publisher.py').read_text()
tree = ast.parse(source)
names = {'mercator_bounds', 'output_grid', 'clean_ir_rgb', '_normalize_rgb_channel', 'air_mass_rgb', 'simple_water_vapor_rgb', 'day_cloud_phase_rgb', 'solar_daylight_alpha', 'encode_webp', 'native_output_strips', 'native_product_rgb', 'encode_native_rgba', 'render_native_scan'}

class Transformer:
    @classmethod
    def from_crs(cls, origin, target, **kwargs):
        return cls(origin)

    def __init__(self, origin):
        self.origin = origin

    def transform(self, x, y):
        if self.origin == 'EPSG:4326':
            return np.asarray(x) * math.pi / 180 * 6378137, np.log(np.tan(math.pi / 4 + np.asarray(y) * math.pi / 360)) * 6378137
        return x, y

puts = {}
cleaned = []
largest_strip = 0
read_mode = 'valid'

def reader(path, gx, gy, stride=1):
    global largest_strip
    largest_strip = max(largest_strip, gx.shape[0])
    assert stride == 1
    if read_mode == 'error':
        raise RuntimeError('Corrupt source')
    if read_mode == 'missing':
        raise RuntimeError('Target sector does not intersect ABI fixed grid')
    return {'channel': path[-2:]}

def sample(channel, gx, gy):
    number = int(channel['channel'])
    if number in (2, 5):
        result = .3 + .15 * np.sin(gx / 1e6) * np.cos(gy / 1e6)
    else:
        result = 230 + number + 30 * np.sin(gx / 1e6) * np.cos(gy / 1e6)
    return result.astype(np.float32)

scope = {
    'np': np, 'math': math, 'Transformer': Transformer, 'Image': Image, 'io': io,
    'OUTPUT_WIDTH': 960, 'NATIVE_REGIONAL_WIDTH': 960, 'WEBP_QUALITY': 88,
    'TRUECOLOR_TERMINATOR_FEATHER_DEGREES': .08, 'TRUECOLOR_DAYLIGHT_CUTOFF_DEGREES': 4,
    'source_crs_from_path': lambda path: 'EPSG:3857',
    'download_source': lambda bucket, key, suffix: key,
    'read_reflectance': reader, 'read_brightness_temperature': reader, 'sample_grid': sample,
    'NATIVE_PREFIX': 'satellite-native',
    'native_frame_key': lambda spec, product, time: f'satellite-native/{spec["prefix"]}/{product}',
    'iso_z': lambda dt: dt.isoformat(),
    'TARGET_S3': SimpleNamespace(put_object=lambda **kwargs: puts.update({kwargs['Key'].split('/')[-1]: kwargs['Body']})),
    'TARGET_BUCKET': 'test', 'os': SimpleNamespace(unlink=lambda path: cleaned.append(path)),
}
exec(compile(ast.fix_missing_locations(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[])), '<native-strips>', 'exec'), scope)
spec = {'bbox': (-105, 25, -85, 45), 'source_bucket': 'test', 'prefix': 'east', 'sector': 'CONUS', 'satellite': 'GOES-19', 'output_width': 960}
group = {'channels': {ch: f'channel{ch}' for ch in ('02', '05', '08', '10', '12', '13')}, 'time': datetime(2026, 10, 4, 18, tzinfo=timezone.utc), 'scan': 'test'}
gx, gy, width, height = scope['output_grid'](spec, 'EPSG:3857')
parts = list(scope['native_output_strips'](spec, 'EPSG:3857'))
np.testing.assert_array_equal(np.concatenate([part[1] for part in parts]), gx)
np.testing.assert_array_equal(np.concatenate([part[2] for part in parts]), gy)
sampled = {ch: sample({'channel': ch}, gx, gy) for ch in group['channels']}
expected = {}
for product in ('clean-ir', 'air-mass', 'simple-water-vapor', 'day-cloud-phase'):
    rgb, valid = scope['native_product_rgb'](product, sampled, group['time'], spec['bbox'], width, height)
    expected[product] = scope['encode_webp'](rgb, valid)[0]
frames = scope['render_native_scan'](spec, group)
assert set(frames) == set(expected)
for product in expected:
    assert puts[product] == expected[product], product
assert len(cleaned) == 6
assert largest_strip <= 256
puts.clear()
group['time'] = datetime(2026, 10, 4, 6, tzinfo=timezone.utc)
frames = scope['render_native_scan'](spec, group)
assert 'day-cloud-phase' not in frames
assert 'clean-ir' in frames
for mode in ('error', 'missing'):
    read_mode = mode
    cleaned.clear()
    try:
        scope['render_native_scan'](spec, group)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Source errors/empty coverage must not publish frames')
    assert len(cleaned) == 6
if '--large' in sys.argv:
    read_mode = 'valid'
    puts.clear()
    scope['NATIVE_REGIONAL_WIDTH'] = 4400
    spec['bbox'] = (-126, 22, -58, 53)
    group['time'] = datetime(2026, 10, 4, 18, tzinfo=timezone.utc)
    frames = scope['render_native_scan'](spec, group)
    assert all(frame['width'] == 4400 for frame in frames.values())
    if sys.platform == 'win32':
        import ctypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', ctypes.c_ulong), ('faults', ctypes.c_ulong), ('peak', ctypes.c_size_t), ('working', ctypes.c_size_t), ('pool_peak', ctypes.c_size_t), ('pool', ctypes.c_size_t), ('nonpaged_peak', ctypes.c_size_t), ('nonpaged', ctypes.c_size_t), ('pagefile', ctypes.c_size_t), ('pagefile_peak', ctypes.c_size_t)]
        counters = Counters()
        handle = ctypes.windll.kernel32.GetCurrentProcess
        handle.restype = ctypes.c_void_p
        assert ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(handle()), ctypes.byref(counters), ctypes.sizeof(counters))
        peak_mb = counters.peak / 1024 / 1024
    else:
        import resource
        peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    assert peak_mb < 1800, peak_mb
    print(f'Synthetic 4400px run peak working set: {peak_mb:.0f} MB')
print('PASS: exact strip geometry and WebP parity for four products, night masking, bounded strip size, source error/empty coverage handling, and source cleanup.')