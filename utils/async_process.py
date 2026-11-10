"""Subprocess startup that retains cleanup ownership during cancellation."""

from __future__ import annotations

import asyncio
import subprocess

from utils.process import safe_terminate


async def finish_in_thread(function, *args, **kwargs):
    """Finish a state-changing worker transaction before honoring cancellation.

    A stop operation owns both process shutdown and the corresponding handle
    reset. Request cancellation must not split those two steps, or a later
    start can mistake a dead receiver handle for an active process.
    """
    pending = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(pending)
            break
        except asyncio.CancelledError:
            if pending.cancelled():
                raise
            cancelled = True
        except Exception:
            if cancelled:
                raise asyncio.CancelledError() from None
            raise
    if cancelled:
        raise asyncio.CancelledError()
    return result


async def async_popen(*args, **kwargs):
    """Spawn off-loop and terminate an unclaimed result if startup is cancelled.

    Cancelling ``to_thread(Popen, ...)`` cannot stop its worker. Shielding the
    result lets us clean up a process created after the request was cancelled,
    instead of losing its handle before assignment in the caller.
    """
    pending = asyncio.create_task(asyncio.to_thread(subprocess.Popen, *args, **kwargs))
    try:
        return await asyncio.shield(pending)
    except asyncio.CancelledError:
        try:
            process = await pending
        except Exception:
            pass
        else:
            await asyncio.to_thread(safe_terminate, process)
        raise
