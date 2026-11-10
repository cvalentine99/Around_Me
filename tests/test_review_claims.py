"""Receiver claims must not run on the event loop.

Claiming an RTL-SDR runs ``rtl_test`` (up to 3 s). Twelve start handlers used
to call the blocking claim directly, freezing every SSE stream, waterfall and
audio socket for the duration of each start.
"""

from __future__ import annotations

import ast
import asyncio
import pathlib
import time

import pytest

import app as app_module
from tests.test_review_aprs import STALL_LIMIT, run_measuring_loop_stall
from utils.sdr.registry import SDRDeviceRegistry

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLOCKING_CLAIMS = {'claim_sdr_device', 'claim_sdr_device_with_lease'}


def _direct_calls(function: ast.AsyncFunctionDef):
    """Calls made by the coroutine itself (nested sync helpers run in workers)."""
    stack = list(ast.iter_child_nodes(function))
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        if isinstance(node, ast.Call):
            yield node
        stack.extend(ast.iter_child_nodes(node))


def test_no_request_handler_claims_a_receiver_on_the_event_loop():
    offenders = []
    for path in sorted((ROOT / 'routes').glob('*.py')) + [ROOT / 'app.py']:
        tree = ast.parse(path.read_text(encoding='utf-8'))
        for function in ast.walk(tree):
            if not isinstance(function, ast.AsyncFunctionDef):
                continue
            for call in _direct_calls(function):
                name = getattr(call.func, 'attr', getattr(call.func, 'id', None))
                if name in BLOCKING_CLAIMS:
                    offenders.append(f'{path.relative_to(ROOT)}:{call.lineno} in {function.name}()')
    assert not offenders, 'blocking receiver claim on the event loop:\n' + '\n'.join(offenders)


@pytest.fixture
def registry(monkeypatch):
    slow_registry = SDRDeviceRegistry(probe=lambda device: time.sleep(0.3))
    monkeypatch.setattr(app_module, '_sdr_registry', slow_registry)
    return slow_registry


async def test_async_claim_keeps_the_event_loop_responsive(registry):
    error, stall = await run_measuring_loop_stall(app_module.claim_sdr_device_async(0, 'sensor'))
    assert error is None
    assert registry.status() == {0: 'sensor'}
    assert stall < STALL_LIMIT, f'claim froze the event loop for {stall:.2f}s'

    error = await app_module.claim_sdr_device_async(0, 'pager')
    assert 'in use by sensor' in error


async def test_async_lease_claim_returns_the_lease(registry):
    error, lease = await app_module.claim_sdr_device_with_lease_async(1, 'waterfall', sdr_type='rtlsdr')
    assert error is None and lease is not None
    assert registry.snapshot() == {1: ('waterfall', lease)}


@pytest.mark.parametrize('claim', ['claim_sdr_device_async', 'claim_sdr_device_with_lease_async'])
async def test_cancelled_claim_does_not_leave_the_receiver_reserved(registry, claim):
    task = asyncio.ensure_future(getattr(app_module, claim)(0, 'sensor'))
    await asyncio.sleep(0.05)          # the probe is running in its worker
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert registry.status() == {}
