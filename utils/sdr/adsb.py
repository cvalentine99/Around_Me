"""Build commands for the installed ADS-B decoder rather than swapping binaries."""

from __future__ import annotations

from functools import lru_cache
import subprocess

from .base import SDRDevice, SDRType


@lru_cache(maxsize=16)
def decoder_help(executable: str) -> str:
    """Inspect compile-time decoder features without opening a receiver."""
    result = subprocess.run(
        [executable, '--help'], capture_output=True, text=True, timeout=5,
    )
    return result.stdout + result.stderr


def readsb_has_native_rtlsdr(help_text: str) -> bool:
    """Readsb only advertises native RTL options when built with that backend."""
    return '--device=' in help_text and '--device-type' in help_text


def build_readsb_command(
    device: SDRDevice,
    executable: str,
    *,
    gain: float | None = None,
    bias_t: bool = False,
    tcp_port: int = 30003,
    help_text: str | None = None,
) -> list[str]:
    """Use native RTL-SDR where available, otherwise select Soapy by serial.

    Readsb's network outputs default to disabled, so enabling --net alone does
    not establish the SBS listener consumed by the application's parser.
    """
    if device.is_network:
        raise ValueError('ADS-B decoding requires a local receiver or a remote SBS connection.')
    if help_text is None:
        help_text = decoder_help(executable)

    cmd = [executable]
    if device.sdr_type == SDRType.RTL_SDR and readsb_has_native_rtlsdr(help_text):
        cmd.extend(['--device-type', 'rtlsdr', '--device', str(device.index)])
        if bias_t:
            if '--enable-biast' not in help_text:
                raise ValueError('The installed readsb does not support RTL-SDR bias-T.')
            cmd.append('--enable-biast')
    else:
        if '--soapy-device' not in help_text:
            raise ValueError(f'The installed readsb does not support {device.sdr_type.value} through SoapySDR.')
        if not device.serial or device.serial in ('N/A', 'Unknown'):
            raise ValueError('A detected receiver serial is required to select the correct SoapySDR device.')
        driver = {
            SDRType.RTL_SDR: 'rtlsdr',
            SDRType.HACKRF: 'hackrf',
            SDRType.LIME_SDR: 'lime',
            SDRType.AIRSPY: device.driver if device.driver in ('airspy', 'airspyhf') else 'airspy',
            SDRType.SDRPLAY: 'sdrplay',
        }[device.sdr_type]
        if any(char in device.serial for char in ',=\r\n'):
            raise ValueError('Invalid receiver serial for SoapySDR selection.')
        device_args = f'driver={driver},serial={device.serial}'
        # Readsb supplies Soapy device args to discovery. Bias-T is a setting,
        # not a discovery argument, and its backend-specific flag is not
        # advertised by this CLI. Never silently turn on a different control.
        if bias_t:
            raise ValueError('The installed readsb SoapySDR backend does not expose bias-T control.')
        cmd.extend(['--device-type', 'soapysdr', '--soapy-device', device_args])

    cmd.extend([
        '--net', '--net-sbs-port', str(tcp_port),
        '--net-bind-address', '127.0.0.1', '--quiet',
    ])
    if gain is not None:
        cmd.extend(['--gain', str(gain)])
    return cmd
