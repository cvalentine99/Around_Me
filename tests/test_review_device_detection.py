"""SDR device detection (rtl_test, hackrf_info, SoapySDRUtil, ~3 s) must not
run on the event loop. The main page polls /devices/status every 5 seconds;
running detection inline froze every stream and button ~2.8 s out of 5."""

from __future__ import annotations

import ast
import pathlib
import time

import pytest

import app as app_module
from tests.test_review_aprs import STALL_LIMIT, run_measuring_loop_stall
from utils.sdr import SDRFactory
from utils.sdr.base import SDRDevice, SDRType

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLOCKING = {'detect_devices', 'detect_all_devices', 'check_all_dependencies'}


def test_no_request_handler_runs_device_detection_on_the_event_loop():
    offenders = []
    for path in sorted((ROOT / 'routes').glob('*.py')) + [ROOT / 'app.py']:
        tree = ast.parse(path.read_text(encoding='utf-8'))
        for function in ast.walk(tree):
            if not isinstance(function, ast.AsyncFunctionDef):
                continue
            stack = list(ast.iter_child_nodes(function))
            while stack:
                node = stack.pop()
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                    continue
                if isinstance(node, ast.Await):
                    continue          # awaited helpers run off the loop
                if isinstance(node, ast.Call) and getattr(node.func, 'attr', getattr(node.func, 'id', None)) in BLOCKING:
                    offenders.append(f'{path.relative_to(ROOT)}:{node.lineno} in {function.name}()')
                stack.extend(ast.iter_child_nodes(node))
    assert not offenders, '\n'.join(offenders)


def device(sdr_type, index):
    return SDRDevice(sdr_type=sdr_type, index=index, name=f'{sdr_type.value} {index}', serial='x',
                     driver=sdr_type.value, capabilities=SDRFactory.get_capabilities(sdr_type)
                     if hasattr(SDRFactory, 'get_capabilities') else None)


@pytest.fixture
def slow_detection(monkeypatch):
    calls = []

    def detect():
        calls.append(1)
        time.sleep(0.3)
        return [device(SDRType.HACKRF, 0), device(SDRType.RTL_SDR, 0)]

    monkeypatch.setattr(SDRFactory, 'detect_devices', staticmethod(detect))
    monkeypatch.setitem(app_module._device_cache, 'devices', None)
    return calls


async def test_device_status_does_not_freeze_the_event_loop(auth_client, slow_detection):
    response, stall = await run_measuring_loop_stall(auth_client.get('/devices/status'))
    assert response.status_code == 200
    assert {d['sdr_type'] for d in await response.get_json()} == {'hackrf', 'rtlsdr'}
    assert stall < STALL_LIMIT, f'/devices/status froze the event loop for {stall:.2f}s'

    # Polling reuses the recent result instead of re-running the tools
    await auth_client.get('/devices/status')
    assert len(slow_detection) == 1


async def test_busy_receiver_stays_listed_when_detection_cannot_open_it(auth_client, monkeypatch, slow_detection):
    await auth_client.get('/devices')                        # both receivers detected
    monkeypatch.setattr(SDRFactory, 'detect_devices',
                        staticmethod(lambda: [device(SDRType.RTL_SDR, 0)]))   # HackRF busy now
    monkeypatch.setattr(app_module, '_detector', lambda: app_module._device_cache['source'])
    monkeypatch.setattr(app_module, 'get_sdr_device_status', lambda: {'hackrf:0': 'sensor'})
    response = await auth_client.get('/devices')
    assert {d['sdr_type'] for d in await response.get_json()} == {'hackrf', 'rtlsdr'}
