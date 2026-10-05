import builtins
import io
import json
import sys
from pathlib import Path

source = Path(__file__).with_name('deploy-cloudshell.sh').read_text()
code = source.split('python3 - "$1" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]
sys.argv = ['test', 'seed-result.json']
for payload, expected_failure in [({'statusCode': 200}, False), ({'errorType': 'Runtime.OutOfMemory', 'errorMessage': 'Killed'}, True), ({'statusCode': 500}, True), ({}, True)]:
    fake_builtins = vars(builtins).copy()
    fake_builtins['open'] = lambda path: io.StringIO(json.dumps(payload))
    failed = False
    try:
        exec(code, {'__builtins__': fake_builtins})
    except SystemExit:
        failed = True
    assert failed == expected_failure, payload
print('PASS: seed verifier accepts success and rejects Lambda failures and invalid responses.')