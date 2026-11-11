"""Read the Identity Resolving Keys (IRKs) of paired devices from BlueZ.

A device that uses resolvable private addresses (most phones, earbuds and
trackers) changes its MAC address every few minutes. Its IRK, exchanged when
it was paired with this host, lets BT Locate recognise each new address.

BlueZ keeps one directory per adapter and per paired device:

    /var/lib/bluetooth/<adapter address>/<device address>/info

with the key in the ``[IdentityResolvingKey]`` section. That tree is
readable by root only.
"""

from __future__ import annotations

import configparser
import os
import re
from pathlib import Path

BLUEZ_STORAGE = Path('/var/lib/bluetooth')

_ADDRESS = re.compile(r'^[0-9A-F]{2}(:[0-9A-F]{2}){5}$')


def _read_info(path: Path) -> configparser.ConfigParser | None:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str  # keep BlueZ's key case
    try:
        with open(path, encoding='utf-8', errors='replace') as handle:
            parser.read_file(handle)
    except (OSError, configparser.Error):
        return None
    return parser


def get_paired_irks(storage_dir: Path | str = BLUEZ_STORAGE) -> list[dict]:
    """Return the paired devices that have an IRK.

    Each entry has ``address``, ``name``, ``adapter``, ``address_type`` and
    ``irk_hex``. ``irk_hex`` is in Bluetooth specification byte order (most
    significant byte first), the order resolve_rpa() and a locate target
    expect. BlueZ stores the key as it travels over SMP, least significant
    byte first, so it is reversed here.

    Returns an empty list when BlueZ has no storage on this host. Raises
    PermissionError when the storage exists but cannot be read (not root),
    so the caller can tell the user why no devices are listed.
    """
    root = Path(storage_dir)
    if not root.is_dir():
        return []
    if not os.access(root, os.R_OK | os.X_OK):
        raise PermissionError(
            f'Reading paired-device keys from {root} requires root privileges')

    devices = []
    for adapter_dir in sorted(root.iterdir()):
        if not _ADDRESS.match(adapter_dir.name.upper()) or not adapter_dir.is_dir():
            continue
        if not os.access(adapter_dir, os.R_OK | os.X_OK):
            raise PermissionError(
                f'Reading paired-device keys from {adapter_dir} requires root privileges')
        for device_dir in sorted(adapter_dir.iterdir()):
            if not _ADDRESS.match(device_dir.name.upper()):
                continue
            info = _read_info(device_dir / 'info')
            if info is None or not info.has_option('IdentityResolvingKey', 'Key'):
                continue
            stored = info.get('IdentityResolvingKey', 'Key').strip()
            try:
                key = bytes.fromhex(stored)
            except ValueError:
                continue
            if len(key) != 16:
                continue
            devices.append({
                'address': device_dir.name.upper(),
                'name': info.get('General', 'Alias', fallback=None)
                        or info.get('General', 'Name', fallback=None),
                'adapter': adapter_dir.name.upper(),
                'address_type': info.get('General', 'AddressType', fallback=None),
                'irk_hex': key[::-1].hex(),
            })
    return devices
