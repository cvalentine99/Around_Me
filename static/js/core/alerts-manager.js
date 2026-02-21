/**
 * AlertRulesManager - Enhanced alert rules CRUD manager
 * Provides full create/read/update/delete for alert rules
 * with filtering, inline editing, and form-based creation.
 */
const AlertRulesManager = (function() {
    'use strict';

    let rules = [];
    let filterMode = '';
    let filterEnabled = '';

    const MODES = [
        'pager', 'sensor', 'wifi', 'bluetooth', 'adsb', 'ais',
        'acars', 'aprs', 'dsc', 'dmr', 'tscm', 'meshtastic'
    ];

    const SEVERITIES = ['low', 'medium', 'high', 'critical'];

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ── Load & Render ──────────────────────────────────────

    function loadRules() {
        fetch('/alerts/rules?all=1')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.status === 'success') {
                    rules = data.rules || [];
                    renderRules();
                }
            })
            .catch(function(err) {
                console.error('[AlertRulesManager] Load rules failed', err);
            });
    }

    function getFilteredRules() {
        return rules.filter(function(rule) {
            if (filterMode && rule.mode !== filterMode) return false;
            if (filterEnabled === 'enabled' && !rule.enabled) return false;
            if (filterEnabled === 'disabled' && rule.enabled) return false;
            return true;
        });
    }

    function renderRules() {
        var container = document.getElementById('alertRulesList');
        if (!container) return;

        var filtered = getFilteredRules();

        if (filtered.length === 0) {
            container.innerHTML = '<div class="arm-empty">No alert rules found</div>';
            return;
        }

        container.innerHTML = filtered.map(function(rule) {
            var severityClass = 'arm-severity-' + (rule.severity || 'medium');
            var matchStr = '';
            try {
                matchStr = rule.match ? JSON.stringify(rule.match) : '{}';
            } catch (e) {
                matchStr = '{}';
            }
            return '<div class="arm-rule-card" data-rule-id="' + escapeHtml(rule.id) + '">' +
                '<div class="arm-rule-header">' +
                    '<div class="arm-rule-name">' + escapeHtml(rule.name) + '</div>' +
                    '<div class="arm-rule-badges">' +
                        '<span class="arm-mode-badge">' + escapeHtml(rule.mode || 'any') + '</span>' +
                        '<span class="arm-severity-badge ' + severityClass + '">' + escapeHtml(rule.severity || 'medium') + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="arm-rule-details">' +
                    '<span class="arm-rule-event-type">Event: ' + escapeHtml(rule.event_type || 'any') + '</span>' +
                    '<span class="arm-rule-match">Match: <code>' + escapeHtml(matchStr) + '</code></span>' +
                '</div>' +
                '<div class="arm-rule-actions">' +
                    '<label class="toggle-switch arm-toggle">' +
                        '<input type="checkbox" ' + (rule.enabled ? 'checked' : '') +
                        ' onchange="AlertRulesManager.updateRule(\'' + escapeHtml(rule.id) + '\', {enabled: this.checked})">' +
                        '<span class="toggle-slider"></span>' +
                    '</label>' +
                    '<select class="arm-severity-select" onchange="AlertRulesManager.updateRule(\'' + escapeHtml(rule.id) + '\', {severity: this.value})">' +
                        SEVERITIES.map(function(s) {
                            return '<option value="' + s + '"' + (s === rule.severity ? ' selected' : '') + '>' + s + '</option>';
                        }).join('') +
                    '</select>' +
                    '<button class="arm-btn arm-btn-edit" onclick="AlertRulesManager.editRule(\'' + escapeHtml(rule.id) + '\')" title="Edit rule">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
                    '</button>' +
                    '<button class="arm-btn arm-btn-delete" onclick="AlertRulesManager.deleteRule(\'' + escapeHtml(rule.id) + '\')" title="Delete rule">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                    '</button>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    // ── Create Rule Form ───────────────────────────────────

    function showCreateForm() {
        var form = document.getElementById('alertRuleCreateForm');
        if (!form) return;
        form.style.display = 'block';
        resetForm();
    }

    function hideCreateForm() {
        var form = document.getElementById('alertRuleCreateForm');
        if (!form) return;
        form.style.display = 'none';
        resetForm();
    }

    function resetForm() {
        var nameEl = document.getElementById('armRuleName');
        var modeEl = document.getElementById('armRuleMode');
        var eventEl = document.getElementById('armRuleEventType');
        var matchEl = document.getElementById('armRuleMatch');
        var sevEl = document.getElementById('armRuleSeverity');
        var enabledEl = document.getElementById('armRuleEnabled');
        var webhookEl = document.getElementById('armRuleWebhook');

        if (nameEl) nameEl.value = '';
        if (modeEl) modeEl.value = '';
        if (eventEl) eventEl.value = '';
        if (matchEl) matchEl.value = '{}';
        if (sevEl) sevEl.value = 'medium';
        if (enabledEl) enabledEl.checked = true;
        if (webhookEl) webhookEl.checked = false;

        // Clear editing state
        var form = document.getElementById('alertRuleCreateForm');
        if (form) {
            form.removeAttribute('data-editing-id');
            var title = form.querySelector('.arm-form-title');
            if (title) title.textContent = 'Create Alert Rule';
            var submitBtn = form.querySelector('.arm-form-submit');
            if (submitBtn) submitBtn.textContent = 'Create Rule';
        }
    }

    function submitForm() {
        var nameEl = document.getElementById('armRuleName');
        var modeEl = document.getElementById('armRuleMode');
        var eventEl = document.getElementById('armRuleEventType');
        var matchEl = document.getElementById('armRuleMatch');
        var sevEl = document.getElementById('armRuleSeverity');
        var enabledEl = document.getElementById('armRuleEnabled');
        var webhookEl = document.getElementById('armRuleWebhook');

        var name = nameEl ? nameEl.value.trim() : '';
        var mode = modeEl ? modeEl.value : '';
        var eventType = eventEl ? eventEl.value.trim() : '';
        var severity = sevEl ? sevEl.value : 'medium';
        var enabled = enabledEl ? enabledEl.checked : true;
        var webhook = webhookEl ? webhookEl.checked : false;

        if (!name) {
            alert('Rule name is required.');
            return;
        }

        var matchObj = {};
        try {
            var matchStr = matchEl ? matchEl.value.trim() : '{}';
            if (matchStr) {
                matchObj = JSON.parse(matchStr);
            }
        } catch (e) {
            alert('Invalid JSON in match conditions: ' + e.message);
            return;
        }

        var payload = {
            name: name,
            mode: mode,
            event_type: eventType,
            match: matchObj,
            severity: severity,
            enabled: enabled,
            notify: { webhook: webhook }
        };

        var form = document.getElementById('alertRuleCreateForm');
        var editingId = form ? form.getAttribute('data-editing-id') : null;

        if (editingId) {
            // Update existing rule
            fetch('/alerts/rules/' + editingId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.status === 'success' || data.id) {
                    hideCreateForm();
                    loadRules();
                } else {
                    alert('Failed to update rule: ' + (data.error || 'Unknown error'));
                }
            })
            .catch(function(err) {
                console.error('[AlertRulesManager] Update rule failed', err);
                alert('Failed to update rule.');
            });
        } else {
            // Create new rule
            fetch('/alerts/rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.status === 'success' || data.id) {
                    hideCreateForm();
                    loadRules();
                } else {
                    alert('Failed to create rule: ' + (data.error || 'Unknown error'));
                }
            })
            .catch(function(err) {
                console.error('[AlertRulesManager] Create rule failed', err);
                alert('Failed to create rule.');
            });
        }
    }

    // ── Update Rule ────────────────────────────────────────

    function updateRule(id, changes) {
        fetch('/alerts/rules/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changes)
        })
        .then(function(r) { return r.json(); })
        .then(function() {
            loadRules();
        })
        .catch(function(err) {
            console.error('[AlertRulesManager] Update rule failed', err);
        });
    }

    // ── Edit Rule (populate form) ──────────────────────────

    function editRule(id) {
        var rule = rules.find(function(r) { return r.id === id; });
        if (!rule) return;

        showCreateForm();

        var form = document.getElementById('alertRuleCreateForm');
        if (form) {
            form.setAttribute('data-editing-id', id);
            var title = form.querySelector('.arm-form-title');
            if (title) title.textContent = 'Edit Alert Rule';
            var submitBtn = form.querySelector('.arm-form-submit');
            if (submitBtn) submitBtn.textContent = 'Update Rule';
        }

        var nameEl = document.getElementById('armRuleName');
        var modeEl = document.getElementById('armRuleMode');
        var eventEl = document.getElementById('armRuleEventType');
        var matchEl = document.getElementById('armRuleMatch');
        var sevEl = document.getElementById('armRuleSeverity');
        var enabledEl = document.getElementById('armRuleEnabled');
        var webhookEl = document.getElementById('armRuleWebhook');

        if (nameEl) nameEl.value = rule.name || '';
        if (modeEl) modeEl.value = rule.mode || '';
        if (eventEl) eventEl.value = rule.event_type || '';
        if (matchEl) {
            try {
                matchEl.value = JSON.stringify(rule.match || {}, null, 2);
            } catch (e) {
                matchEl.value = '{}';
            }
        }
        if (sevEl) sevEl.value = rule.severity || 'medium';
        if (enabledEl) enabledEl.checked = rule.enabled !== false;
        if (webhookEl) webhookEl.checked = !!(rule.notify && rule.notify.webhook);
    }

    // ── Delete Rule ────────────────────────────────────────

    function deleteRule(id) {
        if (!confirm('Delete this alert rule? This cannot be undone.')) return;

        fetch('/alerts/rules/' + id, { method: 'DELETE' })
            .then(function(r) { return r.json(); })
            .then(function() {
                loadRules();
            })
            .catch(function(err) {
                console.error('[AlertRulesManager] Delete rule failed', err);
            });
    }

    // ── Filters ────────────────────────────────────────────

    function setFilterMode(mode) {
        filterMode = mode;
        renderRules();
    }

    function setFilterEnabled(status) {
        filterEnabled = status;
        renderRules();
    }

    // ── Public API ─────────────────────────────────────────

    return {
        loadRules: loadRules,
        showCreateForm: showCreateForm,
        hideCreateForm: hideCreateForm,
        submitForm: submitForm,
        updateRule: updateRule,
        editRule: editRule,
        deleteRule: deleteRule,
        setFilterMode: setFilterMode,
        setFilterEnabled: setFilterEnabled,
        MODES: MODES,
        SEVERITIES: SEVERITIES
    };
})();
