/**
 * Data Export UI - Settings modal integration
 * Handles CSV/JSON/PDF export downloads for all modes.
 */
const DataExportUI = (function() {
    'use strict';

    function download(mode, format) {
        const url = `/analytics/export/${encodeURIComponent(mode)}?format=${encodeURIComponent(format)}`;
        window.open(url, '_blank');
    }

    function downloadTscmPdf() {
        window.open('/tscm/report/pdf', '_blank');
    }

    function downloadWifiV2(format) {
        const url = `/wifi/v2/export?format=${encodeURIComponent(format)}`;
        window.open(url, '_blank');
    }

    return {
        download,
        downloadTscmPdf,
        downloadWifiV2,
    };
})();
