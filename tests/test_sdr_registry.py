"""Receiver ownership follows hardware families rather than display indices."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

from utils.sdr.base import SDRType
from utils.sdr.registry import SDRDeviceRegistry, normalize_sdr_type, sdr_device_key


def test_device_keys_preserve_rtl_and_namespace_other_families():
    assert sdr_device_key(0) == 0
    assert sdr_device_key('1', 'rtl_sdr') == 1
    assert sdr_device_key(0, SDRType.HACKRF) == 'hackrf:0'
    assert sdr_device_key(0, 'lime') == 'limesdr:0'
    assert normalize_sdr_type(SDRType.AIRSPY) == 'airspy'


def test_same_display_index_can_be_claimed_for_independent_receivers():
    probe = Mock(return_value=None)
    registry = SDRDeviceRegistry(probe=probe)
    assert registry.claim(0, 'waterfall') is None
    assert registry.claim(0, 'sensor', SDRType.HACKRF) is None
    assert registry.status() == {0: 'waterfall', 'hackrf:0': 'sensor'}
    probe.assert_called_once_with(0)


def test_existing_family_claim_is_not_overwritten():
    registry = SDRDeviceRegistry(probe=lambda index: None)
    assert registry.claim(0, 'sensor', 'hackrf') is None
    assert 'in use by sensor' in registry.claim(0, 'adsb', 'hackrf')
    assert registry.status() == {'hackrf:0': 'sensor'}


def test_failed_rtl_probe_does_not_block_hackrf_with_same_index():
    probe = Mock(return_value='USB busy')
    registry = SDRDeviceRegistry(probe=probe)
    assert registry.claim(0, 'sensor') == 'USB busy'
    assert registry.claim(0, 'waterfall', 'hackrf') is None
    assert registry.status() == {'hackrf:0': 'waterfall'}


def test_release_preserves_other_family_and_can_check_owner():
    registry = SDRDeviceRegistry(probe=lambda index: None)
    registry.claim(0, 'sensor')
    registry.claim(0, 'waterfall', 'hackrf')
    registry.release(0, 'hackrf', mode_name='old-worker')
    assert registry.status()['hackrf:0'] == 'waterfall'
    registry.release(0)
    assert registry.status() == {'hackrf:0': 'waterfall'}
    registry.release(0, 'hackrf', mode_name='waterfall')
    assert registry.status() == {}


def test_simultaneous_claims_have_one_owner():
    registry = SDRDeviceRegistry(probe=lambda index: None)
    with ThreadPoolExecutor(max_workers=8) as workers:
        results = list(workers.map(lambda number: registry.claim(0, f'mode-{number}'), range(8)))
    assert results.count(None) == 1
    assert len(registry.status()) == 1


def test_old_lease_cannot_release_a_new_capture_after_stop_all():
    registry = SDRDeviceRegistry(probe=lambda index: None)
    error, old = registry.claim_with_lease(0, 'waterfall', 'hackrf')
    assert error is None
    with registry.lock:
        registry.allocations.clear()
    error, current = registry.claim_with_lease(0, 'waterfall', 'hackrf')
    assert error is None and old != current
    registry.release(0, 'hackrf', mode_name='waterfall', lease=old)
    assert registry.status() == {'hackrf:0': 'waterfall'}
    registry.release(0, 'hackrf', mode_name='waterfall', lease=current)
    assert registry.status() == {}


def test_deferred_shutdown_snapshot_does_not_release_new_same_mode_claim():
    registry = SDRDeviceRegistry(probe=lambda index: None)
    registry.claim(0, 'waterfall')
    old = registry.snapshot()[0]
    registry.release(0)
    registry.claim(0, 'waterfall')
    registry.release_key(0, *old)
    assert registry.status() == {0: 'waterfall'}
    registry.release_key(0, *registry.snapshot()[0])
    assert registry.status() == {}

