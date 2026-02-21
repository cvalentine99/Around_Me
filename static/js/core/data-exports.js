/**
 * DataExports - Data export manager for downloading captured signal data
 * Supports CSV/JSON export per mode and TSCM PDF report download.
 */
const DataExports = (function() {
    'use strict';

    const EXPORT_MODES = [
        { id: 'wifi',      label: 'WiFi',      icon: 'wifi' },
        { id: 'bluetooth', label: 'Bluetooth',  icon: 'bluetooth' },
        { id: 'adsb',      label: 'ADS-B',      icon: 'plane' },
        { id: 'ais',       label: 'AIS',        icon: 'anchor' },
        { id: 'sensor',    label: 'Sensors',    icon: 'thermometer' }
    ];

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Trigger file download ──────────────────────────────

    function downloadFile(url, fallbackFilename) {
        var a = document.createElement('a');
        a.href = url;
        a.download = fallbackFilename || '';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
        }, 100);
    }

    // ── Export a mode's data ───────────────────────────────

    function exportMode(mode, format) {
        if (!mode || !format) return;

        var validFormats = ['json', 'csv'];
        if (validFormats.indexOf(format) === -1) {
            console.error('[DataExports] Invalid format:', format);
            return;
        }

        var url = '/analytics/export/' + encodeURIComponent(mode) + '?format=' + encodeURIComponent(format);
        var filename = 'valentine_' + mode + '_export.' + format;

        // Show feedback
        setExportButtonState(mode, format, 'loading');

        fetch(url)
            .then(function(response) {
                if (!response.ok) {
                    throw new Error('Export failed: ' + response.status);
                }
                return response.blob();
            })
            .then(function(blob) {
                var blobUrl = URL.createObjectURL(blob);
                downloadFile(blobUrl, filename);
                setTimeout(function() {
                    URL.revokeObjectURL(blobUrl);
                }, 5000);
                setExportButtonState(mode, format, 'success');
                setTimeout(function() {
                    setExportButtonState(mode, format, 'idle');
                }, 2000);
            })
            .catch(function(err) {
                console.error('[DataExports] Export failed', err);
                setExportButtonState(mode, format, 'error');
                setTimeout(function() {
                    setExportButtonState(mode, format, 'idle');
                }, 3000);
            });
    }

    // ── Export TSCM PDF ────────────────────────────────────

    function exportTscmPdf() {
        var btn = document.getElementById('exportTscmPdfBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Generating...';
        }

        fetch('/tscm/report/pdf')
            .then(function(response) {
                if (!response.ok) {
                    throw new Error('PDF generation failed: ' + response.status);
                }
                return response.blob();
            })
            .then(function(blob) {
                var blobUrl = URL.createObjectURL(blob);
                downloadFile(blobUrl, 'valentine_tscm_report.pdf');
                setTimeout(function() {
                    URL.revokeObjectURL(blobUrl);
                }, 5000);
                if (btn) {
                    btn.textContent = 'Downloaded';
                    btn.disabled = false;
                    setTimeout(function() {
                        btn.textContent = 'Download TSCM PDF Report';
                    }, 2000);
                }
            })
            .catch(function(err) {
                console.error('[DataExports] TSCM PDF export failed', err);
                if (btn) {
                    btn.textContent = 'Export Failed';
                    btn.disabled = false;
                    setTimeout(function() {
                        btn.textContent = 'Download TSCM PDF Report';
                    }, 3000);
                }
            });
    }

    // ── Button state management ────────────────────────────

    function setExportButtonState(mode, format, state) {
        var btnId = 'export-' + mode + '-' + format;
        var btn = document.getElementById(btnId);
        if (!btn) return;

        btn.classList.remove('arm-export-loading', 'arm-export-success', 'arm-export-error');

        switch (state) {
            case 'loading':
                btn.disabled = true;
                btn.classList.add('arm-export-loading');
                btn.textContent = 'Exporting...';
                break;
            case 'success':
                btn.disabled = false;
                btn.classList.add('arm-export-success');
                btn.textContent = 'Done';
                break;
            case 'error':
                btn.disabled = false;
                btn.classList.add('arm-export-error');
                btn.textContent = 'Failed';
                break;
            default:
                btn.disabled = false;
                btn.textContent = format.toUpperCase();
                break;
        }
    }

    // ── Render export grid ─────────────────────────────────

    function renderExportGrid() {
        var container = document.getElementById('dataExportsGrid');
        if (!container) return;

        container.innerHTML = EXPORT_MODES.map(function(mode) {
            return '<div class="arm-export-card">' +
                '<div class="arm-export-card-header">' +
                    '<span class="arm-export-mode-label">' + escapeHtml(mode.label) + '</span>' +
                '</div>' +
                '<div class="arm-export-card-actions">' +
                    '<button id="export-' + mode.id + '-json" class="arm-btn arm-btn-export" ' +
                        'onclick="DataExports.exportMode(\'' + mode.id + '\', \'json\')">' +
                        'JSON' +
                    '</button>' +
                    '<button id="export-' + mode.id + '-csv" class="arm-btn arm-btn-export" ' +
                        'onclick="DataExports.exportMode(\'' + mode.id + '\', \'csv\')">' +
                        'CSV' +
                    '</button>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    // ── Public API ─────────────────────────────────────────

    return {
        exportMode: exportMode,
        exportTscmPdf: exportTscmPdf,
        renderExportGrid: renderExportGrid,
        EXPORT_MODES: EXPORT_MODES
    };
})();
