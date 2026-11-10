"""Execute Aircraft Radar's actual JS handlers with Node's built-in test runner."""

from pathlib import Path
import shutil
import subprocess

import pytest


def test_aircraft_receiver_selection_and_request_payloads():
    node = shutil.which('node')
    if node is None:
        pytest.skip('Node.js is required for dashboard JavaScript regression tests')
    script = Path(__file__).parent / 'frontend' / 'aircraft_receivers.test.cjs'
    result = subprocess.run([node, '--test', str(script)], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
