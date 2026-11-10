"""Regression tests from the pager / sensor / rtlamr / GPS / Meshtastic review.

Every test here is hardware-free: decoder processes, gpsd and the Meshtastic
transport are replaced by in-process fakes.
"""

import asyncio
import threading
import time

import pytest


# =============================================================================
# Meshtastic
# =============================================================================

def _loopback_interface(node_count=9):
    """A real SDK interface whose transport only records what would be sent."""
    pytest.importorskip('meshtastic')
    from meshtastic.mesh_interface import MeshInterface

    class LoopbackInterface(MeshInterface):
        def __init__(self):
            super().__init__(noProto=False)
            self.sent = []

        def _sendToRadioImpl(self, toRadio):
            self.sent.append(toRadio)

    interface = LoopbackInterface()
    interface.nodes = {f'!{num:08x}': {'num': num} for num in range(1, node_count + 1)}
    return interface


def test_traceroute_request_returns_without_waiting_for_the_reply():
    """The SDK's sendTraceRoute() sleeps until a reply or a growing timeout.

    With eight or more known nodes an unanswered request blocked its caller
    (the event loop) for 140 s, then 980 s on the next request, and so on.
    """
    from meshtastic import portnums_pb2
    from utils.meshtastic import MeshtasticClient

    interface = _loopback_interface()
    # Scaled-down SDK timeout: unanswered, the SDK call would still block for
    # 0.2 s * min(nodes - 1, hop_limit) = 1.4 s before raising.
    interface._timeout.expireTimeout = 0.2
    client = MeshtasticClient()
    client._interface = interface
    client._running = True

    started = time.monotonic()
    success, error = client.send_traceroute('!00000002', hop_limit=7)
    elapsed = time.monotonic() - started

    assert (success, error) == (True, None)
    assert elapsed < 0.5, f'traceroute request blocked its caller for {elapsed:.1f}s'
    assert interface._timeout.expireTimeout == 0.2, 'SDK wait timeout was inflated'
    assert len(interface.sent) == 1
    packet = interface.sent[0].packet
    assert packet.to == 2
    assert packet.hop_limit == 7
    assert packet.decoded.portnum == portnums_pb2.PortNum.TRACEROUTE_APP
    assert packet.decoded.want_response is True


def _deliver_from_radio(monkeypatch, client, portnum, payload, sender=0x0A0B0C0D):
    """Decode a received packet with the real SDK and dispatch it to the client."""
    import meshtastic.mesh_interface as mesh_interface
    from meshtastic import mesh_pb2
    from pubsub import pub

    interface = _loopback_interface()
    # The SDK publishes from a worker thread; run it inline for the test.
    monkeypatch.setattr(mesh_interface.publishingThread, 'queueWork', lambda work: work())
    packet = mesh_pb2.MeshPacket()
    setattr(packet, 'from', sender)
    packet.to = 1
    packet.decoded.portnum = portnum
    packet.decoded.payload = payload.SerializeToString()
    pub.subscribe(client._on_receive, 'meshtastic.receive')
    try:
        interface._handlePacketFromRadio(packet)
    finally:
        pub.unsubscribe(client._on_receive, 'meshtastic.receive')


def test_traceroute_reply_from_sdk_is_decoded_into_a_route(monkeypatch):
    """The SDK publishes RouteDiscovery under decoded['traceroute']."""
    pytest.importorskip('meshtastic')
    from meshtastic import mesh_pb2, portnums_pb2
    from utils.meshtastic import MeshtasticClient

    client = MeshtasticClient()
    reply = mesh_pb2.RouteDiscovery(route=[0x11, 0x22], snr_towards=[20, 12, 8])
    _deliver_from_radio(monkeypatch, client, portnums_pb2.PortNum.TRACEROUTE_APP, reply)

    results = client.get_traceroute_results()
    assert len(results) == 1
    assert results[0].destination_id == '!0a0b0c0d'
    assert results[0].route == ['!00000011', '!00000022']
    assert results[0].snr_towards == [5.0, 3.0, 2.0]
    assert results[0].success is True


def test_neighbor_info_from_sdk_populates_topology_and_is_not_a_chat_message(monkeypatch):
    """The SDK names the port NEIGHBORINFO_APP (no underscore after NEIGHBOR)."""
    pytest.importorskip('meshtastic')
    from meshtastic import mesh_pb2, portnums_pb2
    from utils.meshtastic import MeshtasticClient

    client = MeshtasticClient()
    chat = []
    client.set_callback(chat.append)
    report = mesh_pb2.NeighborInfo(
        node_id=0x0A0B0C0D,
        neighbors=[mesh_pb2.Neighbor(node_id=0x33, snr=6.5)],
    )
    _deliver_from_radio(monkeypatch, client, portnums_pb2.PortNum.NEIGHBORINFO_APP, report)

    neighbors = client.get_neighbors()
    assert list(neighbors) == [0x0A0B0C0D]
    assert [(n.neighbor_id, n.snr) for n in neighbors[0x0A0B0C0D]] == [('!00000033', 6.5)]
    assert chat == [], 'topology reports must not be shown as chat messages'


def test_auto_discover_with_several_serial_ports_does_not_exit_the_server(monkeypatch):
    """With no port given the SDK calls sys.exit() when it finds two candidates.

    SystemExit is not an Exception; raised inside a request handler it is
    re-raised by the event loop and stops the whole web server.
    """
    pytest.importorskip('meshtastic')
    import meshtastic.util
    from utils.meshtastic import MeshtasticClient

    monkeypatch.setattr(meshtastic.util, 'findPorts',
                        lambda *args, **kwargs: ['/dev/ttyFAKE0', '/dev/ttyFAKE1'])
    client = MeshtasticClient()
    try:
        connected = client.connect()
    except SystemExit:
        pytest.fail('the SDK sys.exit() escaped MeshtasticClient.connect()')

    assert connected is False
    assert client.is_running is False
    assert 'serial port' in client.error.lower()
    assert client._interface is None
