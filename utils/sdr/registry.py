"""Track receiver ownership without conflating independent SDR families."""

from __future__ import annotations

import threading
from collections.abc import Callable

from .base import SDRType


def normalize_sdr_type(sdr_type: SDRType | str = SDRType.RTL_SDR) -> str:
    """Return the canonical hardware family accepted by route parameters."""
    if isinstance(sdr_type, SDRType):
        return sdr_type.value
    value = str(sdr_type).lower()
    value = {'rtl_sdr': 'rtlsdr', 'lime_sdr': 'limesdr', 'lime': 'limesdr'}.get(value, value)
    return SDRType(value).value


def sdr_device_key(device_index: int, sdr_type: SDRType | str = SDRType.RTL_SDR) -> int | str:
    """Keep legacy RTL integer keys and namespace other receiver indices."""
    family = normalize_sdr_type(sdr_type)
    index = int(device_index)
    return index if family == SDRType.RTL_SDR.value else f'{family}:{index}'


class SDRDeviceRegistry:
    """A shared, thread-safe ownership registry for local receivers.

    ``allocations`` and ``lock`` are exposed for the app's existing status and
    shutdown code. All ordinary ownership changes should use claim/release.
    """

    def __init__(self, probe: Callable[[int], str | None] | None = None):
        self.allocations: dict[int | str, str] = {}
        self.lock = threading.Lock()
        self._probe = probe
        self._leases: dict[int | str, int] = {}
        self._next_lease = 0

    def claim(
        self,
        device_index: int,
        mode_name: str,
        sdr_type: SDRType | str = SDRType.RTL_SDR,
    ) -> str | None:
        error, _ = self.claim_with_lease(device_index, mode_name, sdr_type)
        return error

    def claim_with_lease(
        self,
        device_index: int,
        mode_name: str,
        sdr_type: SDRType | str = SDRType.RTL_SDR,
    ) -> tuple[str | None, int | None]:
        """Atomically claim a receiver and return this acquisition's identity."""
        family = normalize_sdr_type(sdr_type)
        index = int(device_index)
        key = sdr_device_key(index, family)
        with self.lock:
            if key in self.allocations:
                owner = self.allocations[key]
                return (
                    f'SDR device {key} is in use by {owner}. '
                    f'Stop {owner} first or use a different device.', None,
                )

            # A HackRF index is independent of every RTL-SDR index. Probing
            # librtlsdr for it can incorrectly reject an available receiver.
            if family == SDRType.RTL_SDR.value:
                try:
                    from .detection import probe_rtlsdr_device

                    error = (self._probe or probe_rtlsdr_device)(index)
                    if error:
                        return error, None
                except Exception:
                    # Preserve startup's fallback to the decoder's diagnostics
                    # when an optional probing utility is unavailable.
                    pass

            self.allocations[key] = mode_name
            self._next_lease += 1
            self._leases[key] = self._next_lease
            return None, self._next_lease

    def release(
        self,
        device_index: int,
        sdr_type: SDRType | str = SDRType.RTL_SDR,
        *,
        mode_name: str | None = None,
        lease: int | None = None,
    ) -> None:
        key = sdr_device_key(device_index, sdr_type)
        with self.lock:
            if lease is not None and self._leases.get(key) != lease:
                return
            if mode_name is None or self.allocations.get(key) == mode_name:
                self.allocations.pop(key, None)
                self._leases.pop(key, None)

    def status(self) -> dict[int | str, str]:
        with self.lock:
            return dict(self.allocations)

    def snapshot(self) -> dict[int | str, tuple[str, int | None]]:
        """Capture owner and generation together for deferred shutdown work."""
        with self.lock:
            return {key: (owner, self._leases.get(key)) for key, owner in self.allocations.items()}

    def release_key(self, key: int | str, owner: str, lease: int | None) -> None:
        """Release a snapshot entry only if the exact acquisition still owns it."""
        with self.lock:
            if self.allocations.get(key) == owner and self._leases.get(key) == lease:
                self.allocations.pop(key, None)
                self._leases.pop(key, None)

