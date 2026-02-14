# Known Test Issues

Last reviewed: 2026-02-13 (security hardening pass)

## Summary

The test suite has pre-existing failures. These were present **before** the security hardening changes and are not regressions.

## Failure Categories

### 1. Login redirect (302 vs 200)

**Affected:** `test_app.py` (test_index_page, test_dependencies_endpoint, test_devices_endpoint, test_satellite_dashboard, test_adsb_dashboard)

**Cause:** Authentication was added to the app after these tests were written. The test client does not log in, so all protected routes return 302 redirect to `/login` instead of the expected 200.

**Fix:** Tests need to authenticate via the test client session before accessing protected routes.

### 2. Validation test failures

**Affected:** `test_validation.py` (TestFrequencyValidation, TestGainValidation, TestDeviceIndexValidation)

**Cause:** Test assertions don't match current validation function return types/values. The validation module was refactored after the tests were written.

### 3. Weather satellite mock failures

**Affected:** `test_weather_sat.py`

**Cause:** Stale mocks that reference old `WeatherSatDecoder` interfaces. The decoder was rewritten to use SatDump CLI.

### 4. SQLite path assumptions

**Affected:** Various tests that trigger database access

**Cause:** Tests assume the SQLite database is in the default `instance/` path, which may not exist in CI environments.

### 5. Missing system binaries

**Affected:** Integration-style tests that call `shutil.which()` or subprocess

**Cause:** CI environments don't have SDR tools installed (rtl_fm, dump1090, airodump-ng, etc.). These tests need proper mocking or skip decorators.

## Policy

- Do not attempt bulk fixes to the test suite as part of unrelated work.
- New code should include passing tests where feasible.
- Test infrastructure improvements should be tracked as a separate effort.
