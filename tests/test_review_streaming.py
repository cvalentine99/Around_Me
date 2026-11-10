"""Regression tests from the streaming-slice stability review.

Hardware-free: every test drives utils/sse.py, utils/alerts.py,
utils/recording.py and their routes with in-memory queues, a temporary
SQLite database and fake producers.
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import time

import pytest
from quart import Quart

from utils.sse import EventQueue, event_stream_response, format_sse, iterable_stream_response, queue_events


async def _to_thread_latency() -> float:
    """Seconds an unrelated asyncio.to_thread call waits for a default worker."""
    started = time.monotonic()
    await asyncio.wait_for(asyncio.to_thread(lambda: None), 5)
    return time.monotonic() - started


@pytest.fixture
async def two_worker_default_pool():
    """Shrink the loop's default executor, as a 4-core host shrinks it to 8."""
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='review-default')
    asyncio.get_running_loop().set_default_executor(pool)
    yield pool
    pool.shutdown(wait=False)


async def test_idle_event_streams_leave_the_default_thread_pool_free(two_worker_default_pool):
    events = EventQueue(maxsize=4)
    streams = [queue_events(events, timeout=1.0) for _ in range(2)]
    waits = [asyncio.create_task(stream.__anext__()) for stream in streams]
    try:
        while len(events._subscribers) < 2:
            await asyncio.sleep(0)
        await asyncio.sleep(.05)  # both viewers are now parked in their wait
        # As many idle viewers as default workers: a start/stop route's
        # asyncio.to_thread call must still run at once, not after a viewer's
        # one-second queue wait happens to time out.
        assert await _to_thread_latency() < .3
        # ...and the viewers are still served.
        events.put({'type': 'sensor', 'id': 7})
        assert [event['id'] for event in await asyncio.wait_for(asyncio.gather(*waits), 2)] == [7, 7]
    finally:
        for wait in waits:
            wait.cancel()
        await asyncio.gather(*waits, return_exceptions=True)
        for stream in streams:
            await stream.aclose()
    assert not events._subscribers


async def test_idle_iterator_streams_leave_the_default_thread_pool_free(two_worker_default_pool):
    from utils.alerts import AlertManager

    manager = AlertManager()
    # Exactly what GET /alerts/stream returns; every open page holds one.
    bodies = [
        iterable_stream_response(manager.stream_events(timeout=1.0)).response.__aiter__()
        for _ in range(2)
    ]
    waits = [asyncio.create_task(body.__anext__()) for body in bodies]
    try:
        while len(manager._queue._subscribers) < 2:
            await asyncio.sleep(.01)
        await asyncio.sleep(.05)
        assert await _to_thread_latency() < .3
        manager._queue_event({'id': 9, 'title': 'review'})
        frames = await asyncio.wait_for(asyncio.gather(*waits), 2)
        assert all('"id": 9' in frame for frame in frames)
    finally:
        for wait in waits:
            wait.cancel()
        await asyncio.gather(*waits, return_exceptions=True)
        for body in bodies:
            await body.aclose()
    assert not manager._queue._subscribers


def _strict_json(text):
    """Parse the way a browser's JSON.parse does: NaN / Infinity are errors."""
    def reject(token):
        raise ValueError(f'{token} is not JSON')

    return json.loads(text, parse_constant=reject)


def _sse_data(frame):
    if isinstance(frame, bytes):
        frame = frame.decode()
    return next(line[len('data: '):] for line in frame.splitlines() if line.startswith('data: '))


async def test_unserialisable_event_does_not_end_the_stream_or_poison_reconnects():
    events = EventQueue(maxsize=8)
    # One odd field from a decoder must not cost every viewer the whole stream:
    # the event stays in the replay history, so each reconnect would die on it.
    events.put({
        'type': 'sensor',
        'id': 'odd',
        'raw': b'\x00\xff',
        'seen': datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        'tags': {'only'},
        ('tuple', 'key'): 1,
    })
    events.put({'type': 'sensor', 'id': 'after'})
    app = Quart(__name__)

    @app.route('/events')
    async def stream():
        return event_stream_response(events, timeout=.01, keepalive_interval=5)

    for _ in range(2):  # first connection, then the browser's reconnect
        async with app.test_client().request('/events', method='GET') as connection:
            odd = _strict_json(_sse_data(await asyncio.wait_for(connection.receive(), 1)))
            assert odd['id'] == 'odd'
            assert odd['raw'] == '00ff'
            assert odd['seen'] == '2026-01-02T03:04:05+00:00'
            assert odd['tags'] == ['only']
            after = _strict_json(_sse_data(await asyncio.wait_for(connection.receive(), 1)))
            assert after['id'] == 'after'
            await connection.disconnect()
    assert not events._subscribers


def test_non_finite_numbers_are_sent_as_valid_json():
    # rtl_power prints "nan" / "-inf" bins and float() accepts them; json.dumps
    # then writes NaN / -Infinity, which JSON.parse rejects in the browser.
    frame = format_sse({
        'type': 'waterfall_sweep',
        'bins': [-41.5, float('nan'), float('-inf'), float('inf'), -40.0],
        'nested': {'snr': float('nan')},
    })
    assert _strict_json(_sse_data(frame)) == {
        'type': 'waterfall_sweep',
        'bins': [-41.5, None, None, None, -40.0],
        'nested': {'snr': None},
    }
    # Ordinary payloads are byte-for-byte what they were.
    ordinary = {'type': 'sensor', 'id': 1234, 'temperature_C': 21.5, 'name': 'café', 'ok': True, 'none': None}
    assert format_sse(ordinary) == f'data: {json.dumps(ordinary)}\n\n'
