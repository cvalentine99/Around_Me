"""Server-Sent Events (SSE) utilities."""

from __future__ import annotations

import asyncio
import copy
import json
import math
import queue
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from enum import Enum
from typing import Any, Generator

# An open stream parks one thread in a bounded queue read almost all the time.
# Those waits get a pool of their own: on the event loop's default executor
# (min(32, cpus + 4) workers, 8 on a 4-core host) a handful of open browser
# streams would hold every worker, and each asyncio.to_thread call elsewhere
# in the application would then wait for a stream's read to time out.
# Threads are created on demand, so the limit costs nothing until it is used.
STREAM_WAIT_WORKERS = 256
_stream_wait_executor: ThreadPoolExecutor | None = None
_stream_wait_executor_lock = threading.Lock()


def _stream_wait(func, *args):
    """Run a bounded blocking stream read off the loop and off its default pool."""
    global _stream_wait_executor
    with _stream_wait_executor_lock:
        if _stream_wait_executor is None:
            _stream_wait_executor = ThreadPoolExecutor(
                max_workers=STREAM_WAIT_WORKERS, thread_name_prefix='sse-wait')
        executor = _stream_wait_executor
    return asyncio.get_running_loop().run_in_executor(executor, func, *args)


class _PublishedEvent(dict):
    """A normal event dictionary with transport metadata outside its payload."""

    def __init__(self, event: dict, event_id: str):
        super().__init__(event)
        self.event_id = event_id


def _cursor_parts(cursor: str | None):
    if not isinstance(cursor, str):
        return None
    try:
        stream, number = cursor.rsplit(':', 1)
        sequence = int(number)
        if stream and sequence >= 0:
            return stream, sequence
    except (ValueError, TypeError):
        pass
    return None


def _already_received(event: Any, cursor: str | None) -> bool:
    previous = _cursor_parts(cursor)
    current = _cursor_parts(getattr(event, 'event_id', None))
    return bool(previous and current and previous[0] == current[0] and current[1] <= previous[1])


def _request_cursor() -> str | None:
    from quart import has_request_context, request

    return request.headers.get('Last-Event-ID') if has_request_context() else None


class EventQueue(queue.Queue):
    """Bounded event history with independent queues for live subscribers.

    Existing decoder producers can keep using ``put``/``put_nowait`` and
    diagnostic readers can keep using the normal Queue API. Live subscribers
    receive their own copy of the recent history and subsequent events. A slow
    or absent browser never blocks the decoder. Recording and alert processing
    happens once at publication, independently of the number of viewers.
    """

    def __init__(self, maxsize: int = 1000, *, mode: str | None = None, event_mapper=None):
        super().__init__(maxsize=maxsize)
        self.mode = mode
        self.event_mapper = event_mapper
        self._publish_lock = threading.RLock()
        self._subscribers: set[queue.Queue] = set()
        # A queue instance has its own cursor namespace. After a server restart
        # an old browser cursor must not hide events from the new instance.
        self._stream_id = uuid.uuid4().hex
        self._sequence = 0

    @staticmethod
    def _put_latest(target: queue.Queue, item: Any) -> None:
        with target.not_full:
            if target.maxsize > 0 and target._qsize() >= target.maxsize:
                target._get()
                target.unfinished_tasks = max(0, target.unfinished_tasks - 1)
            target._put(item)
            target.unfinished_tasks += 1
            target.not_empty.notify()

    def put(self, item: Any, block: bool = True, timeout: float | None = None) -> None:
        # Radio producers must keep draining subprocess output even without a
        # viewer. This queue deliberately drops the oldest delivery copy when
        # full; the event pipeline runs before any delivery copy is discarded.
        try:
            item = copy.deepcopy(item)
        except (TypeError, ValueError):
            pass
        # Storage or alert delivery may perform I/O. Never hold the subscription
        # lock during that work: a browser opening a stream must not wait for a
        # producer's webhook or database operation on the event-loop thread.
        if self.mode:
            from utils.event_pipeline import process_event

            if self.event_mapper:
                event_type, payload = self.event_mapper(item)
            else:
                event_type = item.get('type') if isinstance(item, dict) else None
                payload = item
            process_event(self.mode, payload, event_type)
        with self._publish_lock:
            self._sequence += 1
            if isinstance(item, dict):
                item = _PublishedEvent(item, f'{self._stream_id}:{self._sequence}')
            self._put_latest(self, item)
            for subscriber in self._subscribers:
                self._put_latest(subscriber, item)

    @contextmanager
    def subscribe(self, *, replay: bool = True, last_event_id: str | None = None):
        """Subscribe atomically with a snapshot of the bounded recent history."""
        subscriber = queue.Queue(maxsize=self.maxsize if self.maxsize > 0 else 1000)
        with self._publish_lock:
            if replay:
                with self.mutex:
                    history = list(self.queue)
                for item in history:
                    if not _already_received(item, last_event_id):
                        self._put_latest(subscriber, item)
            self._subscribers.add(subscriber)
        try:
            yield subscriber
        finally:
            with self._publish_lock:
                self._subscribers.discard(subscriber)

    def clear_history(self) -> None:
        """Begin a new producer session without replaying its predecessor."""
        with self._publish_lock:
            with self.mutex:
                removed = self._qsize()
                self.queue.clear()
                self.unfinished_tasks = max(0, self.unfinished_tasks - removed)
                if self.unfinished_tasks == 0:
                    self.all_tasks_done.notify_all()
                self.not_full.notify_all()


@contextmanager
def event_subscription(data_queue: queue.Queue, *, last_event_id: str | None = None):
    """Use broadcast subscriptions while supporting plain queues in callers."""
    if isinstance(data_queue, EventQueue):
        with data_queue.subscribe(last_event_id=last_event_id) as subscriber:
            yield subscriber
    else:
        yield data_queue


async def queue_events(
    data_queue: queue.Queue,
    timeout: float = 1.0,
    keepalive_interval: float = 30.0,
    stop_check=None,
    last_event_id: str | None = None,
):
    """Yield queue events without blocking the loop or competing with viewers."""
    last_event = time.monotonic()
    with event_subscription(data_queue, last_event_id=last_event_id) as subscriber:
        while not stop_check or not stop_check():
            try:
                event = await _stream_wait(subscriber.get, True, timeout)
                last_event = time.monotonic()
                yield event
            except queue.Empty:
                if time.monotonic() - last_event >= keepalive_interval:
                    last_event = time.monotonic()
                    yield {'type': 'keepalive'}


def event_stream_response(data_queue: queue.Queue, *, timeout: float = 1.0,
                          keepalive_interval: float = 30.0, event_mapper=None, stop_check=None):
    """Create an indefinite SSE response over a private event subscription."""
    from quart import Response

    cursor = _request_cursor()

    async def generate():
        events = queue_events(data_queue, timeout, keepalive_interval, stop_check, cursor)
        try:
            async for event in events:
                if event_mapper:
                    name, payload = event_mapper(event)
                    yield format_sse(payload, event=name, event_id=getattr(event, 'event_id', None))
                else:
                    yield format_sse(event)
        finally:
            await events.aclose()

    response = Response(generate(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
    })
    response.timeout = None
    return response


def iterable_stream_response(events, *, event_mapper=None):
    """Advance blocking event iterators in a worker and close on disconnect."""
    from quart import Response

    cursor = _request_cursor()

    async def generate():
        iterator = iter(events)
        end = object()
        pending = None
        try:
            while True:
                pending = _stream_wait(next, iterator, end)
                event = await asyncio.shield(pending)
                if event is end:
                    return
                if _already_received(event, cursor):
                    continue
                if event_mapper:
                    name, payload = event_mapper(event)
                    yield format_sse(payload, event=name, event_id=getattr(event, 'event_id', None))
                else:
                    yield format_sse(event)
        finally:
            # A canceled executor wait does not stop its thread. Let the
            # bounded read finish before closing the generator, otherwise its
            # private subscription could remain registered after disconnect.
            if pending is not None:
                await asyncio.shield(pending)
            close = getattr(iterator, 'close', None)
            if close:
                await _stream_wait(close)

    response = Response(generate(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
    })
    response.timeout = None
    return response


def sse_stream(
    data_queue: queue.Queue,
    timeout: float = 1.0,
    keepalive_interval: float = 30.0,
    stop_check: callable = None
) -> Generator[str, None, None]:
    """
    Generate SSE stream from a queue.

    Args:
        data_queue: Queue to read messages from
        timeout: Queue get timeout in seconds
        keepalive_interval: Seconds between keepalive messages
        stop_check: Optional callable that returns True to stop the stream

    Yields:
        SSE formatted strings
    """
    last_keepalive = time.monotonic()
    with event_subscription(data_queue) as subscriber:
        while True:
            if stop_check and stop_check():
                break
            try:
                msg = subscriber.get(timeout=timeout)
                last_keepalive = time.monotonic()
                yield format_sse(msg)
            except queue.Empty:
                now = time.monotonic()
                if now - last_keepalive >= keepalive_interval:
                    yield format_sse({'type': 'keepalive'})
                    last_keepalive = now


def _json_default(value: Any) -> Any:
    """Encode what json cannot, so one odd field never costs viewers a stream."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).hex()
    if isinstance(value, (set, frozenset)):
        try:
            return sorted(value)
        except TypeError:
            return list(value)
    if isinstance(value, Enum):
        return value.value
    # datetime / date / time, then numpy scalars and arrays.
    for convert in ('isoformat', 'tolist'):
        method = getattr(value, convert, None)
        if callable(method):
            try:
                return method()
            except Exception:
                break
    return str(value)


def _plain_json(value: Any) -> Any:
    """Rebuild a payload from JSON types only; NaN and Infinity become null."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, dict):
        return {
            key if key is None or isinstance(key, (str, int)) else str(key): _plain_json(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_plain_json(item) for item in value]
    return _plain_json(_json_default(value))


_json_encoder = json.JSONEncoder(default=_json_default, allow_nan=False)


def dumps_event(data: Any) -> str:
    """json.dumps for event payloads that always yields JSON a browser accepts.

    An exception here would end the response generator, and because the event
    stays in the replay history every reconnect would end on it too. NaN and
    Infinity (json.dumps writes them as bare tokens) are rejected by
    JSON.parse, so they are sent as null. Ordinary payloads take the first
    branch and are encoded exactly as json.dumps encodes them.
    """
    try:
        return _json_encoder.encode(data)
    except (TypeError, ValueError):
        return _json_encoder.encode(_plain_json(data))


def format_sse(data: dict[str, Any] | str, event: str | None = None, event_id: str | None = None) -> str:
    """
    Format data as SSE message.

    Args:
        data: Data to send (will be JSON encoded if dict)
        event: Optional event name
        event_id: Optional transport cursor, separate from the JSON payload

    Returns:
        SSE formatted string
    """
    event_id = event_id or getattr(data, 'event_id', None)
    if isinstance(data, dict):
        data = dumps_event(data)

    lines = []
    if event_id:
        lines.append(f"id: {event_id}")
    if event:
        lines.append(f"event: {event}")
    lines.append(f"data: {data}")
    lines.append("")
    lines.append("")

    return '\n'.join(lines)


def clear_queue(q: queue.Queue) -> int:
    """
    Clear all items from a queue.

    Args:
        q: Queue to clear

    Returns:
        Number of items cleared
    """
    count = 0
    while True:
        try:
            q.get_nowait()
            count += 1
        except queue.Empty:
            break
    return count

def async_sse_stream_fanout(
    source_queue: queue.Queue,
    channel_key: str | None = None,
    timeout: float = 1.0,
    keepalive_interval: float = 30.0,
    stop_check=None,
    on_message=None,
):
    """SSE body for modules written against the older fan-out helper API.

    Every viewer of an EventQueue already gets its own subscription, and an
    EventQueue with a mode runs the recording/alert pipeline when an event is
    published, so ``on_message`` only runs for other sources. ``channel_key``
    is accepted for compatibility and not needed.
    """
    cursor = _request_cursor()
    run_hook = on_message is not None and not (
        isinstance(source_queue, EventQueue) and source_queue.mode)

    async def generate():
        events = queue_events(source_queue, timeout, keepalive_interval, stop_check, cursor)
        try:
            async for event in events:
                if run_hook and isinstance(event, dict) and event.get('type') != 'keepalive':
                    try:
                        on_message(event)
                    except Exception:
                        pass
                yield format_sse(event)
        finally:
            await events.aclose()

    return generate()


def async_sse_stream(
    data_queue: queue.Queue,
    timeout: float = 1.0,
    keepalive_interval: float = 30.0,
    stop_check=None,
    channel_key: str | None = None,
):
    """Compatibility alias of async_sse_stream_fanout without a message hook."""
    return async_sse_stream_fanout(data_queue, channel_key, timeout, keepalive_interval, stop_check)
