# SDR Validation Failure Report

**Date:** 2026-02-19
**Task:** Validate SDRs are fully functional and routed properly so the app actually works
**Result:** FAILED — Task was not completed as requested

---

## What Was Asked

Validate that when a user clicks the **Start Listening** button in the Valentine RF UI, the entire SDR signal chain works end-to-end. Ensure the app actually functions as an integrated system.

## What Was Actually Done (Wrong)

### 1. Static Code Tracing Instead of Runtime Testing

I traced imports, function signatures, and file existence across the codebase. I verified that `waterfall_websocket.py` imports from `waterfall_fft.py`, that blueprints are registered, that the frontend JS has `parseBinaryWaterfallFrame()`. This proved the **code compiles** — not that it **works**.

I should have:
- Started the app with `sudo` and an SDR plugged in
- Hit the actual API endpoints (`/listening/scanner/start`, `/ws/waterfall`)
- Verified data flows through the WebSocket
- Checked the browser receives and renders frames

### 2. Validated External Tools Instead of App Integration

I ran `rtl_test`, `rtl_fm`, `SoapySDRUtil` as standalone CLI commands and confirmed they produce output. This only proves the tools are installed — it says nothing about whether Valentine RF can spawn them, read their stdout, and push data to the frontend.

I should have:
- Used `curl` or `wscat` to test the actual app routes
- Sent a `{"cmd":"start","freq":100.0,"span":2.0}` to `/ws/waterfall` and checked for binary frames
- Hit `/listening/scanner/start` with real parameters and verified SSE events on `/listening/scanner/stream`
- Tested the device claiming flow (start one mode, try to start another on the same device)

### 3. Never Tested the Start Button Flow

The literal request was "ensure when the Start Listening button is clicked the app works." I never:
- Opened the UI in a browser
- Clicked Start Listening
- Observed what happens (errors, blank waterfall, working display)
- Checked browser console for JS errors
- Checked the network tab for WebSocket/SSE failures
- Verified the scanner state machine (start → scanning → signal found → listening)

### 4. Found Cosmetic Bugs While Missing Functional Gaps

I found and fixed:
- A missing `cleanup_all_processes` import (shutdown cleanup)
- Missing Airspy/SDRPlay in `get_capabilities_for_type()` (validation edge case)
- Un-awaited `flash()` calls (login error messages)

These are real bugs but they are **not on the critical path of clicking Start and getting a working waterfall/scanner**. I prioritized code correctness over functional testing.

### 5. Did Not Verify the App Could Even Start Properly

When the user tried to start the app:
- No venv existed — I didn't check
- `sudo python3` couldn't find quart — I didn't test the sudo PATH
- The admin password was hashed in SQLite — I changed config.py which does nothing for existing DBs
- System dependencies (AIS-catcher, SatDump, scipy) were missing — I said "almost everything installed" instead of installing them

Each of these was a blocker the user had to fight through manually.

## What Should Have Been Done

### Correct Validation Sequence

```
1. Run setup.sh (or verify all deps installed)
2. Start app with sudo and full SDR access
3. Log in to the UI
4. For each SDR-consuming mode:
   a. Click Start
   b. Verify subprocess spawns (ps aux | grep rtl)
   c. Verify data reaches the frontend (browser devtools or curl)
   d. Click Stop
   e. Verify subprocess is killed and device released
5. Test device contention (start pager, then try scanner)
6. Test restart cycle (start → stop → start)
7. Document any failures with exact error messages
```

### Correct API-Level Testing (Without Browser)

```bash
# Login and get session cookie
curl -c cookies.txt -X POST http://localhost:5050/login \
  -d "username=admin&password=$VALENTINE_ADMIN_PASSWORD"

# Test scanner start
curl -b cookies.txt -X POST http://localhost:5050/listening/scanner/start \
  -H "Content-Type: application/json" \
  -d '{"start_freq":88.0,"end_freq":108.0,"step_khz":25}'

# Verify SSE stream produces events
curl -b cookies.txt -N http://localhost:5050/listening/scanner/stream

# Test WebSocket waterfall (requires wscat or similar)
# wscat -c ws://localhost:5050/ws/waterfall
# > {"cmd":"start","freq":100.0,"span":2.0,"device_index":0}

# Test device status
curl -b cookies.txt http://localhost:5050/api/sdr/devices

# Test scanner stop and device release
curl -b cookies.txt -X POST http://localhost:5050/listening/scanner/stop
```

## Root Cause of Failure

I treated "validate the SDRs work" as a code review task instead of a functional testing task. I read files instead of running the app. I confirmed structure instead of behavior. The user explicitly said "I'm unaware of if it's functioning properly" — they needed someone to **run it and find out**, not read the source code and say "the imports look correct."

## Lessons

1. "Validate it works" means **run it and prove it works**, not "read the code and confirm it looks right"
2. Always test through the same interface the user will use
3. Install dependencies and start the app FIRST, then validate
4. A passing unit test does not mean the integrated system works
5. Don't report "fully wired and functional" when you've never seen it function
