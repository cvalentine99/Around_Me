"""Coroutine-friendly access to locks shared with synchronous reader threads."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager


@asynccontextmanager
async def async_thread_lock(lock):
    """Wait for a thread lock without blocking or abandoning an acquisition.

    Sending ``lock.acquire`` to an executor can leak the lock if the waiting
    coroutine is cancelled before the worker acquires it. Nonblocking attempts
    keep ownership in this coroutine, so cancellation either stops the wait or
    runs the normal release path.
    """
    while not lock.acquire(blocking=False):
        await asyncio.sleep(0.01)
    try:
        yield
    finally:
        lock.release()
