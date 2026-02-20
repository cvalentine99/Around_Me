"""Tests for rtl_fm modulation mode translation.

Ensures _rtl_fm_demod_mode() correctly translates app modulation names
to the -M flag values that rtl_fm actually accepts.

rtl_fm accepts: am, fm, wbfm, raw, usb, lsb
Our app uses 'wfm' for wideband FM — rtl_fm calls it 'wbfm'.
"""

import pytest
from routes.listening_post import _rtl_fm_demod_mode, normalize_modulation, VALID_MODULATIONS


class TestRtlFmDemodMode:
    """Test _rtl_fm_demod_mode() translation function."""

    def test_wfm_translates_to_wbfm(self):
        """WFM (wideband FM) must become 'wbfm' for rtl_fm."""
        assert _rtl_fm_demod_mode('wfm') == 'wbfm'

    def test_fm_passes_through(self):
        """Narrowband FM passes through unchanged."""
        assert _rtl_fm_demod_mode('fm') == 'fm'

    def test_am_passes_through(self):
        """AM passes through unchanged."""
        assert _rtl_fm_demod_mode('am') == 'am'

    def test_usb_passes_through(self):
        """Upper sideband passes through unchanged."""
        assert _rtl_fm_demod_mode('usb') == 'usb'

    def test_lsb_passes_through(self):
        """Lower sideband passes through unchanged."""
        assert _rtl_fm_demod_mode('lsb') == 'lsb'

    def test_all_valid_modulations_have_translation(self):
        """Every valid modulation must produce a non-empty rtl_fm -M value."""
        for mod in VALID_MODULATIONS:
            result = _rtl_fm_demod_mode(mod)
            assert result, f"Empty translation for modulation '{mod}'"
            assert isinstance(result, str)

    def test_wfm_is_only_translated_modulation(self):
        """Only 'wfm' should be translated; all others pass through."""
        for mod in VALID_MODULATIONS:
            result = _rtl_fm_demod_mode(mod)
            if mod == 'wfm':
                assert result != mod, "wfm must be translated to wbfm"
            else:
                assert result == mod, f"'{mod}' should pass through unchanged, got '{result}'"


class TestNormalizeModulation:
    """Test normalize_modulation() validation."""

    def test_valid_modulations(self):
        """All valid modulations should normalize successfully."""
        for mod in VALID_MODULATIONS:
            assert normalize_modulation(mod) == mod

    def test_case_insensitive(self):
        """Modulation names should be case-insensitive."""
        assert normalize_modulation('WFM') == 'wfm'
        assert normalize_modulation('AM') == 'am'
        assert normalize_modulation('Fm') == 'fm'

    def test_strips_whitespace(self):
        """Leading/trailing whitespace should be stripped."""
        assert normalize_modulation('  wfm  ') == 'wfm'
        assert normalize_modulation('\tam\n') == 'am'

    def test_invalid_modulation_raises(self):
        """Invalid modulation names should raise ValueError."""
        with pytest.raises(ValueError, match='Invalid modulation'):
            normalize_modulation('invalid')

    def test_wbfm_is_not_valid_app_modulation(self):
        """'wbfm' is an rtl_fm value, not an app value — should be rejected."""
        with pytest.raises(ValueError, match='Invalid modulation'):
            normalize_modulation('wbfm')

    def test_empty_string_raises(self):
        """Empty string should raise ValueError."""
        with pytest.raises(ValueError, match='Invalid modulation'):
            normalize_modulation('')

    def test_none_raises(self):
        """None should raise ValueError."""
        with pytest.raises(ValueError, match='Invalid modulation'):
            normalize_modulation(None)


class TestDemodModeIntegration:
    """Integration tests: normalize → translate pipeline."""

    def test_wfm_pipeline(self):
        """User sends 'wfm' → normalize → demod → rtl_fm gets 'wbfm'."""
        normalized = normalize_modulation('wfm')
        rtl_flag = _rtl_fm_demod_mode(normalized)
        assert rtl_flag == 'wbfm'

    def test_fm_pipeline(self):
        """User sends 'fm' → normalize → demod → rtl_fm gets 'fm'."""
        normalized = normalize_modulation('fm')
        rtl_flag = _rtl_fm_demod_mode(normalized)
        assert rtl_flag == 'fm'

    def test_case_insensitive_wfm_pipeline(self):
        """User sends 'WFM' → normalize → demod → rtl_fm gets 'wbfm'."""
        normalized = normalize_modulation('WFM')
        rtl_flag = _rtl_fm_demod_mode(normalized)
        assert rtl_flag == 'wbfm'
