"""Build the Canada/Mexico supplement without replacing detailed US outlines."""
import argparse
from collections import Counter
import io
import json
from pathlib import Path
import sys
import zipfile

local_dependencies = Path(__file__).parent / 'geometry-deps'
if local_dependencies.exists():
    sys.path.insert(0, str(local_dependencies))
import shapefile
from shapely.geometry import mapping, shape

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()

def rounded(value):
    if isinstance(value, (tuple, list)):
        return [rounded(item) for item in value]
    return round(value, 5)

features = []
with zipfile.ZipFile(args.archive) as archive:
    stem = 'ne_10m_admin_1_states_provinces'
    reader = shapefile.Reader(shp=io.BytesIO(archive.read(stem+'.shp')),
                             shx=io.BytesIO(archive.read(stem+'.shx')),
                             dbf=io.BytesIO(archive.read(stem+'.dbf')), encoding='utf-8')
    for item in reader.iterShapeRecords():
        record = item.record.as_dict()
        if record['adm0_a3'] not in ('CAN', 'MEX'):
            continue
        # Natural Earth includes an unnamed Mexican pseudo-division MX-X01~.
        if not record['name'] or '~' in record['iso_3166_2']:
            continue
        geometry = shape(item.shape.__geo_interface__)
        assert geometry.is_valid
        geometry = geometry.simplify(.001, preserve_topology=True)
        assert geometry.is_valid
        geojson = mapping(geometry)
        geojson['coordinates'] = rounded(geojson['coordinates'])
        features.append({'type': 'Feature', 'properties': {
            'name': record.get('name_en') or record['name'],
            'country': record['adm0_a3'], 'abbr': record['iso_3166_2']}, 'geometry': geojson})
counts = Counter(feature['properties']['country'] for feature in features)
assert counts == {'CAN': 13, 'MEX': 32}, counts
data = {'type': 'FeatureCollection', 'source': 'Natural Earth 1:10m Admin 1 states/provinces 5.1.1',
        'sourceUrl': 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/',
        'downloadUrl': 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip',
        'license': 'Public domain', 'simplificationToleranceDegrees': .001,
        'features': sorted(features, key=lambda feature: feature['properties']['abbr'])}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(data, ensure_ascii=True, separators=(',', ':'))+'\n', encoding='utf-8')
print(json.dumps({'counts': counts, 'bytes': args.output.stat().st_size}))
