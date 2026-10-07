"""Exercise publisher retention without loading native rendering dependencies."""
import ast
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

root = Path(__file__).resolve().parent
source = root / 'satellite_mesoscale_publisher.py'
if not source.exists():
    source = root.parent / 'aws/satellite-truecolor-publisher/satellite_mesoscale_publisher.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'process_sector')
constants = [node for node in tree.body if isinstance(node, ast.Assign)
             and any(isinstance(target, ast.Name) and target.id in
                     {'PRODUCTS', 'MAX_HISTORY_FRAMES', 'HISTORY_WINDOW_MINUTES'} for target in node.targets)]


class RetentionTests(unittest.TestCase):
    def test_hour_history_age_location_and_deletion_scope(self):
        now = datetime(2026, 10, 7, 0, 3, tzinfo=timezone.utc)
        def frame(minutes, geometry='current', path=None):
            return {'scan': str(minutes), 'time': (now-timedelta(minutes=minutes)).isoformat(),
                    'geometry': geometry, 'path': path or f'east/meso-1/13/frames/{minutes}.webp'}
        frames = [frame(i) for i in range(1, 65)]
        frames += [frame(66), frame(64.5, 'old'), frame(80, path='radar/untouched.webp')]
        outputs, deleted = [], []
        abi = SimpleNamespace(
            read_manifest=lambda spec: {'frames': frames}, datetime=datetime,
            iso_z=lambda value: value.isoformat(), TARGET_BUCKET='test', TARGET_PREFIX='satellite-mesoscale',
            manifest_key=lambda spec: spec['prefix']+'/manifest.json',
            TARGET_S3=SimpleNamespace(put_object=lambda **kw: outputs.append(json.loads(kw['Body'])),
                                      delete_object=lambda **kw: deleted.append(kw['Key'])))
        namespace = {'abi': abi, 'os': os, 'json': json, 'timedelta': timedelta,
                     'list_scans': lambda *args: []}
        exec(compile(ast.Module(body=constants+[function], type_ignores=[]), str(source), 'exec'), namespace)
        result = namespace['process_sector']('East', 'GOES-19', 'unused', 1, now)
        self.assertEqual(result['attempted'], 0)
        self.assertEqual(result['frames'], {product: 60 for product in namespace['PRODUCTS']})
        for output in outputs:
            self.assertEqual(len(output['frames']), 60)
            self.assertEqual(output['frames'][0]['scan'], '60')
            self.assertEqual(output['frames'][-1]['scan'], '1')
            self.assertTrue(all(f['geometry'] == 'current' for f in output['frames']))
        self.assertTrue(deleted)
        self.assertTrue(all(key.startswith('satellite-mesoscale/east/meso-1/') for key in deleted))
        self.assertTrue(all('radar/' not in key for key in deleted))


if __name__ == '__main__':
    unittest.main()
