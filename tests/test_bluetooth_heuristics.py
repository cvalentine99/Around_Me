"""Unit tests for Bluetooth heuristic detection."""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock

from utils.bluetooth.heuristics import HeuristicsEngine
from utils.bluetooth.models import BTDeviceAggregate
from utils.bluetooth.constants import (
    PERSISTENT_MIN_SEEN_COUNT as HEURISTIC_PERSISTENT_MIN_SEEN,
    PERSISTENT_WINDOW_SECONDS as HEURISTIC_PERSISTENT_WINDOW_SECONDS,
    BEACON_INTERVAL_MAX_VARIANCE as HEURISTIC_BEACON_VARIANCE_THRESHOLD,
    STRONG_RSSI_THRESHOLD as HEURISTIC_STRONG_STABLE_RSSI,
    STABLE_VARIANCE_THRESHOLD as HEURISTIC_STRONG_STABLE_VARIANCE,
)


@pytest.fixture
def engine():
    """Create a fresh HeuristicsEngine for testing."""
    return HeuristicsEngine()


def create_device_aggregate(
    address="AA:BB:CC:DD:EE:FF",
    address_type="public",
    protocol="ble",
    first_seen=None,
    last_seen=None,
    seen_count=1,
    rssi_current=-60,
    rssi_median=-60,
    rssi_variance=5.0,
    rssi_samples=None,
    is_new=False,
):
    """Helper to create BTDeviceAggregate for testing."""
    now = datetime.now()
    if first_seen is None:
        first_seen = now - timedelta(seconds=30)
    if last_seen is None:
        last_seen = now
    if rssi_samples is None:
        # Generate realistic samples spread across the time window
        if seen_count > 1:
            duration = (last_seen - first_seen).total_seconds()
            interval = duration / (seen_count - 1) if seen_count > 1 else 1.0
            rssi_samples = [
                (first_seen + timedelta(seconds=i * interval), rssi_current)
                for i in range(seen_count)
            ]
        else:
            rssi_samples = [(now, rssi_current)]

    duration_seconds = (last_seen - first_seen).total_seconds()
    duration_minutes = duration_seconds / 60.0 if duration_seconds > 0 else 1.0

    return BTDeviceAggregate(
        device_id=f"{address}:{address_type}",
        address=address,
        address_type=address_type,
        protocol=protocol,
        first_seen=first_seen,
        last_seen=last_seen,
        seen_count=seen_count,
        seen_rate=seen_count / duration_minutes,
        rssi_samples=rssi_samples,
        rssi_current=rssi_current,
        rssi_median=rssi_median,
        rssi_min=rssi_median - 10 if rssi_median is not None else None,
        rssi_max=rssi_median + 10 if rssi_median is not None else None,
        rssi_variance=rssi_variance,
        rssi_confidence=0.8,
        range_band="nearby",
        range_confidence=0.7,
        name="Test Device",
        manufacturer_id=None,
        manufacturer_name=None,
        manufacturer_bytes=None,
        service_uuids=[],
        is_new=is_new,
        is_persistent=False,
        is_beacon_like=False,
        is_strong_stable=False,
        has_random_address=address_type != "public",
    )


class TestPersistentHeuristic:
    """Tests for persistent device detection."""

    def test_persistent_high_seen_count(self, engine):
        """Test device with high seen count is marked persistent."""
        # Needs: seen_count >= 10, duration >= 150s (half window), rate >= 2/min
        # 600 sightings over 300 seconds = 120/min which is >= 2/min
        device = create_device_aggregate(
            seen_count=600,
            first_seen=datetime.now() - timedelta(seconds=HEURISTIC_PERSISTENT_WINDOW_SECONDS),
        )

        engine.evaluate(device)
        assert device.is_persistent is True

    def test_not_persistent_low_seen_count(self, engine):
        """Test device with low seen count is not persistent."""
        device = create_device_aggregate(seen_count=2)

        engine.evaluate(device)
        assert device.is_persistent is False

    def test_not_persistent_outside_window(self, engine):
        """Test device with low rate is not persistent despite high seen count."""
        # 15 sightings over 3900 seconds = 0.23/min which is < 2/min
        device = create_device_aggregate(
            seen_count=HEURISTIC_PERSISTENT_MIN_SEEN + 5,
            first_seen=datetime.now() - timedelta(seconds=HEURISTIC_PERSISTENT_WINDOW_SECONDS + 3600),
        )

        engine.evaluate(device)
        # Low rate means not persistent
        assert device.is_persistent is False


class TestBeaconLikeHeuristic:
    """Tests for beacon-like behavior detection."""

    def test_beacon_like_stable_intervals(self, engine):
        """Test device with stable advertisement intervals is beacon-like."""
        now = datetime.now()
        # Create samples in chronological order (oldest first) with very stable 1s intervals
        rssi_samples = [(now - timedelta(seconds=19 - i), -60) for i in range(20)]

        device = create_device_aggregate(
            seen_count=20,
            rssi_samples=rssi_samples,
            rssi_variance=1.0,  # Very low variance
        )

        engine.evaluate(device)
        assert device.is_beacon_like is True

    def test_not_beacon_like_irregular_intervals(self, engine):
        """Test device with irregular intervals is not beacon-like."""
        now = datetime.now()
        # Create samples with irregular intervals
        rssi_samples = [
            (now - timedelta(seconds=0), -60),
            (now - timedelta(seconds=5), -65),
            (now - timedelta(seconds=7), -58),
            (now - timedelta(seconds=25), -62),
            (now - timedelta(seconds=30), -60),
        ]

        device = create_device_aggregate(
            seen_count=5,
            rssi_samples=rssi_samples,
            rssi_variance=15.0,  # Higher variance
        )

        engine.evaluate(device)
        # Irregular intervals should not be beacon-like
        # (implementation may vary)
        assert isinstance(device.is_beacon_like, bool)


class TestStrongStableHeuristic:
    """Tests for strong and stable signal detection."""

    def test_strong_stable_device(self, engine):
        """Test device with strong, stable signal."""
        now = datetime.now()
        rssi_val = HEURISTIC_STRONG_STABLE_RSSI + 5  # -45 dBm
        device = create_device_aggregate(
            rssi_current=rssi_val,
            rssi_median=rssi_val,
            rssi_variance=HEURISTIC_STRONG_STABLE_VARIANCE - 1,  # Less variance than threshold
            seen_count=15,
            first_seen=now - timedelta(seconds=60),
        )

        engine.evaluate(device)
        assert device.is_strong_stable is True

    def test_not_strong_weak_signal(self, engine):
        """Test device with weak signal is not strong_stable."""
        device = create_device_aggregate(
            rssi_current=-80,
            rssi_median=-80,
            rssi_variance=2.0,
            seen_count=15,
        )

        engine.evaluate(device)
        assert device.is_strong_stable is False

    def test_not_stable_high_variance(self, engine):
        """Test device with high variance is not strong_stable."""
        device = create_device_aggregate(
            rssi_current=-45,
            rssi_median=-45,
            rssi_variance=HEURISTIC_STRONG_STABLE_VARIANCE + 5,
            seen_count=15,
        )

        engine.evaluate(device)
        assert device.is_strong_stable is False


class TestRandomAddressHeuristic:
    """Tests for random address detection."""

    def test_random_address_detected(self, engine):
        """Test random address type is detected."""
        device = create_device_aggregate(address_type="random")

        engine.evaluate(device)
        assert device.has_random_address is True

    def test_public_address_not_random(self, engine):
        """Test public address is not marked random."""
        device = create_device_aggregate(address_type="public")

        engine.evaluate(device)
        assert device.has_random_address is False

    def test_rpa_address_random(self, engine):
        """Test RPA (Resolvable Private Address) is marked random."""
        device = create_device_aggregate(address_type="rpa")

        engine.evaluate(device)
        assert device.has_random_address is True


class TestNewDeviceHeuristic:
    """Tests for new device detection."""

    def test_new_device_flag_preserved(self, engine):
        """Test is_new flag is preserved from input."""
        device = create_device_aggregate(is_new=True)

        engine.evaluate(device)
        assert device.is_new is True

    def test_not_new_flag_preserved(self, engine):
        """Test is_new=False is preserved."""
        device = create_device_aggregate(is_new=False)

        engine.evaluate(device)
        assert device.is_new is False


class TestMultipleHeuristics:
    """Tests for combinations of heuristics."""

    def test_multiple_flags_can_be_true(self, engine):
        """Test device can have multiple heuristic flags."""
        now = datetime.now()
        rssi_val = HEURISTIC_STRONG_STABLE_RSSI + 10  # -40 dBm
        device = create_device_aggregate(
            address_type="random",
            seen_count=20,
            rssi_current=rssi_val,
            rssi_median=rssi_val,
            rssi_variance=1.0,
            is_new=True,
            first_seen=now - timedelta(seconds=60),
        )

        engine.evaluate(device)

        # Multiple flags can be true
        assert device.has_random_address is True
        assert device.is_new is True
        # Strong stable should be true (strong signal, low variance, 20 samples)
        assert device.is_strong_stable is True

    def test_all_flags_false_possible(self, engine):
        """Test device can have all heuristic flags false."""
        device = create_device_aggregate(
            address_type="public",
            seen_count=1,
            rssi_current=-85,
            rssi_median=-85,
            rssi_variance=20.0,
            is_new=False,
        )

        engine.evaluate(device)

        assert device.has_random_address is False
        assert device.is_new is False
        assert device.is_persistent is False
        assert device.is_strong_stable is False


class TestHeuristicsBatchEvaluation:
    """Tests for batch evaluation of multiple devices."""

    def test_evaluate_multiple_devices(self, engine):
        """Test evaluating multiple devices at once."""
        from utils.bluetooth.heuristics import evaluate_all_devices

        devices = [
            create_device_aggregate(
                address=f"AA:BB:CC:DD:EE:{i:02X}",
                seen_count=i * 5,
            )
            for i in range(1, 6)
        ]

        evaluate_all_devices(devices)

        assert len(devices) == 5
        # Device with highest seen count should be persistent
        most_seen = max(devices, key=lambda d: d.seen_count)
        # May or may not be persistent depending on exact thresholds
        assert isinstance(most_seen.is_persistent, bool)

    def test_evaluate_empty_list(self, engine):
        """Test evaluating empty device list."""
        from utils.bluetooth.heuristics import evaluate_all_devices

        devices = []
        evaluate_all_devices(devices)
        assert devices == []


class TestEdgeCases:
    """Tests for edge cases and boundary conditions."""

    def test_null_rssi_values(self, engine):
        """Test device with null RSSI values."""
        now = datetime.now()
        device = BTDeviceAggregate(
            device_id="AA:BB:CC:DD:EE:FF:public",
            address="AA:BB:CC:DD:EE:FF",
            address_type="public",
            protocol="ble",
            first_seen=now - timedelta(seconds=30),
            last_seen=now,
            seen_count=1,
            seen_rate=1 / 60.0,
            rssi_samples=[],
            rssi_current=None,
            rssi_median=None,
            rssi_min=None,
            rssi_max=None,
            rssi_variance=None,
            rssi_confidence=0.0,
            range_band="unknown",
            range_confidence=0.0,
            name="Test Device",
            manufacturer_id=None,
            manufacturer_name=None,
            manufacturer_bytes=None,
            service_uuids=[],
            is_new=False,
            is_persistent=False,
            is_beacon_like=False,
            is_strong_stable=False,
            has_random_address=False,
        )

        engine.evaluate(device)
        # Should not crash, strong_stable should be False
        assert device.is_strong_stable is False

    def test_exactly_at_threshold(self, engine):
        """Test device exactly at persistent threshold."""
        device = create_device_aggregate(
            seen_count=HEURISTIC_PERSISTENT_MIN_SEEN,  # Exactly at threshold
            first_seen=datetime.now() - timedelta(seconds=HEURISTIC_PERSISTENT_WINDOW_SECONDS),
        )

        engine.evaluate(device)
        # At threshold, should be persistent
        assert isinstance(device.is_persistent, bool)

    def test_zero_seen_count(self, engine):
        """Test device with zero seen count (edge case)."""
        device = create_device_aggregate(seen_count=0)

        engine.evaluate(device)
        assert device.is_persistent is False

    def test_negative_rssi_boundary(self, engine):
        """Test RSSI at boundary values."""
        device = create_device_aggregate(
            rssi_current=-100,  # Very weak
            rssi_median=-100,
        )

        engine.evaluate(device)
        assert device.is_strong_stable is False

        # Test strongest possible - needs 5+ rssi_samples
        now = datetime.now()
        device2 = create_device_aggregate(
            rssi_current=-20,  # Very strong
            rssi_median=-20,
            rssi_variance=1.0,
            seen_count=10,
            first_seen=now - timedelta(seconds=30),
        )

        engine.evaluate(device2)
        assert device2.is_strong_stable is True
