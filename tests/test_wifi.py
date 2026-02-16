import pytest
import sys
import os
from unittest.mock import MagicMock, patch, mock_open
from quart import Quart
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from routes.wifi import wifi_bp, parse_airodump_csv

@pytest.fixture
def mock_app_module():
    """Mock the app_module imported inside routes.wifi."""
    with patch("routes.wifi.app_module") as mock:
        mock.wifi_lock = MagicMock()
        mock.wifi_process = None
        mock.wifi_monitor_interface = None
        mock.wifi_queue = MagicMock()
        mock.wifi_networks = {}
        mock.wifi_clients = {}
        yield mock

@pytest.fixture
def app():
    app = Quart(__name__)
    app.register_blueprint(wifi_bp)
    return app

@pytest.fixture
def client(app):
    return app.test_client()

def test_parse_airodump_csv():
    """Test parsing logic for airodump CSV format."""
    csv_content = (
        "BSSID, First time seen, Last time seen, channel, Speed, Privacy, Cipher, Authentication, Power, # beacons, # IV, LAN IP, ID-length, ESSID, Key\n"
        "AA:BB:CC:DD:EE:FF, 2023-01-01, 2023-01-01, 6, 54, WPA2, CCMP, PSK, -50, 10, 5, 0.0.0.0, 7, MyWiFi, \n"
        "\n"
        "Station MAC, First time seen, Last time seen, Power, # packets, BSSID, Probes\n"
        "11:22:33:44:55:66, 2023-01-01, 2023-01-01, -60, 20, AA:BB:CC:DD:EE:FF, MyWiFi\n"
    )

    with patch("builtins.open", mock_open(read_data=csv_content)), \
         patch("routes.wifi.get_manufacturer", return_value="Apple"):
        networks, clients = parse_airodump_csv("dummy.csv")

        assert "AA:BB:CC:DD:EE:FF" in networks
        assert networks["AA:BB:CC:DD:EE:FF"]["essid"] == "MyWiFi"
        assert "11:22:33:44:55:66" in clients
        assert clients["11:22:33:44:55:66"]["vendor"] == "Apple"

### --- ROUTE TESTS --- ###

async def test_get_interfaces(client):
    """Test the /interfaces endpoint."""
    with patch("routes.wifi.detect_wifi_interfaces", return_value=[{'name': 'wlan0', 'type': 'managed'}]), \
         patch("routes.wifi.check_tool", return_value=True):
        response = await client.get('/wifi/interfaces')
        data = await response.get_json()

        assert response.status_code == 200
        assert len(data['interfaces']) == 1
        assert data['tools']['airmon'] is True

async def test_toggle_monitor_start_success(client):
    """Test enabling monitor mode via airmon-ng."""
    mock_run = MagicMock(stdout="enabled on [phy0]wlan0mon", stderr="", returncode=0)
    with patch("routes.wifi.validate_network_interface", return_value="wlan0"), \
         patch("routes.wifi.check_tool", return_value=True), \
         patch("routes.wifi.subprocess.run", return_value=mock_run), \
         patch("os.path.exists", return_value=True):
        response = await client.post('/wifi/monitor', json={'action': 'start', 'interface': 'wlan0'})
        data = await response.get_json()

        assert response.status_code == 200
        assert data['status'] == 'success'
        assert data['monitor_interface'] == 'wlan0mon'

async def test_start_scan_already_running(client, mock_app_module):
    """Test that we can't start a scan if one is already active."""
    mock_app_module.wifi_process = MagicMock()

    response = await client.post('/wifi/scan/start', json={'interface': 'wlan0mon'})
    data = await response.get_json()
    assert data['status'] == 'error'
    assert 'already running' in data['message']

async def test_start_scan_execution(client, mock_app_module):
    """Test the full command construction of airodump-ng."""
    mock_app_module.wifi_process = None
    mock_proc = MagicMock()
    mock_proc.poll.return_value = None

    with patch("os.path.exists", return_value=True), \
         patch("routes.wifi.get_tool_path", return_value="/usr/bin/airodump-ng"), \
         patch("routes.wifi.subprocess.Popen", return_value=mock_proc) as mock_popen:
        payload = {'interface': 'wlan0mon', 'channel': 6, 'band': 'g'}
        response = await client.post('/wifi/scan/start', json=payload)
        data = await response.get_json()

        assert response.status_code == 200
        assert data['status'] == 'started'

        args, _ = mock_popen.call_args
        cmd = args[0]
        assert "-c" in cmd and "6" in cmd
        assert "wlan0mon" in cmd

async def test_stop_scan(client, mock_app_module):
    """Test terminating the scanning process."""
    mock_proc = MagicMock()
    mock_app_module.wifi_process = mock_proc

    response = await client.post('/wifi/scan/stop')
    data = await response.get_json()

    assert response.status_code == 200
    assert data['status'] == 'stopped'
    mock_proc.terminate.assert_called_once()

async def test_send_deauth_success(client, mock_app_module):
    """Verify deauth command construction and execution."""
    mock_run_result = MagicMock(returncode=0)
    with patch("routes.wifi.check_tool", return_value=True), \
         patch("routes.wifi.get_tool_path", return_value="/usr/bin/aireplay-ng"), \
         patch("routes.wifi.subprocess.run", return_value=mock_run_result) as mock_run:
        payload = {
            'bssid': 'AA:BB:CC:DD:EE:FF',
            'count': 10,
            'interface': 'wlan0mon'
        }
        response = await client.post('/wifi/deauth', json=payload)
        data = await response.get_json()

        assert response.status_code == 200
        args, _ = mock_run.call_args
        cmd = args[0]
        assert "--deauth" in cmd
        assert "10" in cmd
        assert "AA:BB:CC:DD:EE:FF" in cmd

### --- HANDSHAKE TESTS --- ###

async def test_capture_handshake_start(client, mock_app_module):
    """Test starting airodump-ng for handshake capture."""
    mock_app_module.wifi_process = None
    with patch("routes.wifi.get_tool_path", return_value="/usr/bin/airodump-ng"), \
         patch("routes.wifi.subprocess.Popen") as mock_popen:
        payload = {'bssid': 'AA:BB:CC:DD:EE:FF', 'channel': '6', 'interface': 'wlan0mon'}
        response = await client.post('/wifi/handshake/capture', json=payload)
        data = await response.get_json()

        assert response.status_code == 200
        assert 'capture_file' in data
        assert mock_popen.called

async def test_check_handshake_status_found(client):
    """Verify detection of 'KEY FOUND' in aircrack output."""
    mock_run_result = MagicMock(stdout="WPA (1 handshake)", stderr="", returncode=0)
    with patch("os.path.exists", return_value=True), \
         patch("os.path.getsize", return_value=1024), \
         patch("routes.wifi.get_tool_path", return_value="aircrack-ng"), \
         patch("routes.wifi.subprocess.run", return_value=mock_run_result):
        payload = {'file': '/tmp/valentine_handshake_test.cap', 'bssid': 'AA:BB:CC:DD:EE:FF'}
        response = await client.post('/wifi/handshake/status', json=payload)
        data = await response.get_json()

        assert data['handshake_found'] is True

### --- PMKID TESTS --- ###

async def test_capture_pmkid_path_traversal_prevention(client):
    """Ensure the status check rejects invalid paths."""
    payload = {'file': '/etc/passwd'} # Malicious path
    response = await client.post('/wifi/pmkid/status', json=payload)
    data = await response.get_json()

    assert response.status_code == 200
    assert data['status'] == 'error'
    assert 'Invalid capture file path' in data['message']

### --- CRACKING TESTS --- ###

async def test_crack_handshake_success(client):
    """Test successful password extraction using Regex."""
    mock_run_result = MagicMock(
        stdout="KEY FOUND! [ secret123 ]",
        stderr="",
        returncode=0
    )
    with patch("os.path.exists", return_value=True), \
         patch("routes.wifi.get_tool_path", return_value="aircrack-ng"), \
         patch("routes.wifi.subprocess.run", return_value=mock_run_result):
        payload = {
            'capture_file': '/tmp/valentine_handshake_test.cap',
            'wordlist': '/home/user/passwords.txt',
            'bssid': 'AA:BB:CC:DD:EE:FF'
        }
        response = await client.post('/wifi/handshake/crack', json=payload)
        data = await response.get_json()

        assert data['status'] == 'success'
        assert data['password'] == 'secret123'

### --- DATA FETCHING TESTS --- ###

async def test_get_wifi_networks(client, mock_app_module):
    """Test that the networks endpoint correctly formats internal data."""
    mock_app_module.wifi_networks = {
        'AA:BB:CC:DD:EE:FF': {'essid': 'Home-WiFi', 'bssid': 'AA:BB:CC:DD:EE:FF'}
    }
    mock_app_module.wifi_handshakes = ['AA:BB:CC:DD:EE:FF']

    response = await client.get('/wifi/networks')
    data = await response.get_json()

    assert len(data['networks']) == 1
    assert data['networks'][0]['essid'] == 'Home-WiFi'
    assert 'AA:BB:CC:DD:EE:FF' in data['handshakes']
