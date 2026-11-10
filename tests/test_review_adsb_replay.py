"""A new ADS-B session must not replay the previous session's aircraft.

The live hardware run showed event ids :1-:3 of session 1 delivered again to
the viewer of session 2 after Stop + Start: the queue replays its history to
every new subscriber and ADS-B never cleared it.
"""

from __future__ import annotations

from unittest.mock import Mock

from routes import adsb
from tests.test_review_aircraft import aircraft  # noqa: F401  (fixture)


async def test_new_adsb_session_does_not_replay_old_aircraft(aircraft, monkeypatch):  # noqa: F811
    monkeypatch.setattr(adsb, 'parse_sbs_stream', Mock())
    aircraft.app.adsb_queue.put({'type': 'aircraft', 'icao': 'AB4383', 'altitude': 35000})

    response = await aircraft.client.post(
        '/adsb/start', json={'remote_sbs_host': '127.0.0.1', 'remote_sbs_port': 30003})
    assert response.status_code == 200, await response.get_json()

    with aircraft.app.adsb_queue.subscribe() as viewer:      # a browser opening the stream
        replayed = []
        while not viewer.empty():
            replayed.append(viewer.get_nowait())
    assert not [event for event in replayed if event.get('type') == 'aircraft'], replayed
