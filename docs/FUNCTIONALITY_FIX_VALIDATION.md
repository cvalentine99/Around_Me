# Functionality fixes and validation

Implemented November 9, 2026, against the reviewed working tree. Three agents
handled SDR integration, concurrency, and streaming; the main task integrated
authentication, controller calls, module controls, and validation.

## Fixes

| Review finding | Result | Regression coverage |
| --- | --- | --- |
| 1. ADS-B passed dump1090 arguments to readsb | Commands match the installed native/Soapy readsb capabilities, select the intended receiver, and explicitly enable local SBS output. RTL-SDR can fall back to dump1090 when necessary. Startup errors retain useful diagnostics and use a failing HTTP status. | `test_adsb_startup.py` |
| 2. Browser audio/controller requests returned 401 | Authenticated browser sessions work without manual tokens; explicit API tokens remain supported. Agent ingestion uses its registered key, or authenticated user credentials for a keyless registration. | `test_app_workflows.py` |
| 3. Concurrent scan requests deadlocked the event loop | Shared thread locks are acquired without blocking the event loop. Worker shutdown completes its state cleanup even when a request is repeatedly canceled. | `test_scan_concurrency.py` |
| 4. Populated Bluetooth heatmaps deadlocked | Device lookup under the existing aggregator lock no longer reacquires that lock. | `test_scan_concurrency.py` |
| 5. WiFi streaming blocked the event loop | Blocking scanner iterators advance in workers; disconnect cleanup retires their subscriptions. | `test_event_streaming.py` |
| 6. Remote-agent calls were not awaited | Controller registration, health, refresh, start, stop, status, data, and monitor operations await the actual async client methods. Controller mocks now preserve that async contract. | `test_app_workflows.py`, `test_controller.py` |
| 7. WebSocket radio controls bypassed authentication | Quart's WebSocket authentication hook rejects anonymous handshakes and users still required to change their initial password. | `test_app_workflows.py` |
| 8. Fresh installations shared a fixed administrator password | The generated random fallback is used again. README documents startup credentials and environment overrides. | `test_app_workflows.py` |
| 9. Stop All missed readsb and discarded live handles | Shutdown targets app-owned handles, retains failed terminations, and compares acquisition generations before releasing reservations. The browser displays failures instead of falsely marking every module stopped. | `test_scan_concurrency.py`, `test_app_workflows.py` |
| 10. Start Enabled Modules reported successful starts as failures | The orchestrator awaits Quart response deserialization and preserves each module's result and HTTP status. | `test_app_workflows.py` |
| 11. Different SDR families collided at index 0 | Receiver reservations include the hardware family. Generic routes retain their claimed family; connection-owned captures use acquisition generations so stale callbacks cannot release a newer receiver. | `test_sdr_registry.py`, `test_sdr_route_identity.py` |
| 12. Streams ended at Quart's normal response deadline | SSE and streaming audio responses override the ordinary total-response deadline. | `test_app_workflows.py`, `test_event_streaming.py` |
| 13. Multiple viewers divided the event queue | Each subscriber receives its own bounded event delivery queue. Event IDs and native EventSource reconnect preserve a cursor rather than replaying already received messages. | `test_event_streaming.py` |
| 14. Recordings and alerts required an open viewer | Processing happens once at event publication, before viewer delivery. Slow viewers cannot block decoder output, and replay does not duplicate storage or alerts. | `test_event_streaming.py` |

Additional lifecycle tests cover delayed weather-satellite completion callbacks,
mutable scheduler configuration, and old output readers completing after a newer
capture starts. WiFi/Bluetooth session restart and actual JavaScript event-handler
tests cover stale status replay and native reconnect behavior.

## Automated validation

Final complete run: **995 passed**, including the live hardware tests, in
121.60 seconds. The suite contains 99 more cases than the reviewed baseline.
It emitted 225 existing datetime deprecation warnings and had no failures or skips.

Run the complete suite from the project root:

```bash
venv/bin/python -m pytest -q --tb=short
```

All 55 changed/new Python files passed compilation. Patch whitespace checks passed
while retaining the repository's existing CRLF line endings.

## Live receiver validation

The application detected two Nooelec NESDR SMArt v5 RTL-SDR receivers and one
HackRF One. Validation used the actual Quart routes and WebSocket handlers with a
temporary database, a real login, and the initial password-change flow.

| Workflow | Observed result |
| --- | --- |
| Browser authentication | Controller API returned 200 using the login session, without a bearer token. |
| Concurrent receivers | RTL-SDR 0 and HackRF 0 simultaneously delivered waterfall frames. Each checked frame had 1,024 FFT bins and 1,035 total bytes. Both independent registry entries remained allocated during capture. |
| ADS-B startup | The installed `readsb` stayed running, opened the configured SBS port, and the app connected to it. No aircraft messages arrived during the short observation. |
| Stop All | The app-owned ADS-B process exited, the endpoint returned 200, and the receiver registry was empty. |
| Browser FM audio | Session-authenticated audio returned RIFF/WAVE data continuously for 65 seconds: 5,726,418 bytes across 1,018 chunks, including data beyond the former 60-second cutoff. |
| Module orchestration | Start Enabled Modules returned success for the real sensor receiver, which remained running during the three-second check. |
| Cleanup | Test receivers were stopped and the app's receiver registry was empty afterward. |

The repeatable receive-only check is available from the project root:

```bash
venv/bin/python tests/live_receiver_check.py --sustained
```

It requires two RTL-SDR receivers and additionally checks a connected HackRF when
`rx_sdr` is available. It creates temporary account/recording data and stops the
receivers it starts.

These checks establish application-level startup, sample/audio delivery,
authentication, ownership, and shutdown. Browser speaker playback and over-the-air
pager, DMR, maritime, sensor-packet, and satellite-image decoding were not verified.

## Aircraft Radar receiver selection follow-up

The dashboard still sent a numeric receiver index without its hardware family.
With both HackRF 0 and RTL-SDR 0 attached, choosing the HackRF could therefore
request RTL-SDR 0 and conflict with ACARS. A second loader also replaced valid
index 0 with the device's position in the combined enumeration list.

Receiver options now use distinct identities such as `hackrf:0` and `rtlsdr:0`,
and every aircraft start action sends both the native index and hardware family.
ACARS and UAT offer only supported RTL-SDR receivers. Active status restores the
actual running receiver; refreshes and source changes retain each selection.
The backend rejects unsupported families before probing or reserving a receiver.
Old decoder readers cannot clear the state of a replacement capture.

Follow-up regression run: **1,008 passed, 6 live tests deselected** in 85.64
seconds, with the same 225 existing warnings. This includes 18 new backend cases
and a Node-backed frontend check containing 18 receiver-selection scenarios.
All 58 changed/new Python files compiled, and patch whitespace checks passed.
