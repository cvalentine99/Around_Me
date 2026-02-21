/**
 * Alert Rules Manager UI - Settings modal integration
 * Manages CRUD operations for alert rules from the Settings > Alerts tab.
 */
const AlertRulesUI = (function() {
    'use strict';

    let rules = [];

    function init() {
        loadRules();
    }

    function loadRules() {
        fetch('/alerts/rules?all=1')
            .then(r => r.json())
            .then(data => {
                if (data.status === 'success') {
                    rules = data.rules || [];
                    render();
                }
            })
            .catch(err => console.error('[AlertRules] Load failed', err));
    }

    function render() {
        const list = document.getElementById('alertRulesList');
        const countEl = document.getElementById('alertRulesCount');
        if (countEl) countEl.textContent = `(${rules.length})`;
        if (!list) return;

        if (rules.length === 0) {
            list.innerHTML = '<div class="settings-feed-empty">No alert rules configured</div>';
            return;
        }

        list.innerHTML = rules.map(rule => {
            const severityColors = {
                critical: 'var(--accent-red)',
                high: 'var(--accent-orange)',
                medium: '#f59e0b',
                low: 'var(--accent-green)'
            };
            const sevColor = severityColors[rule.severity] || 'var(--text-dim)';
            const enabledBadge = rule.enabled
                ? '<span style="color: var(--accent-green); font-size: 10px;">ON</span>'
                : '<span style="color: var(--text-dim); font-size: 10px;">OFF</span>';

            return `
                <div class="settings-feed-item" style="display: flex; align-items: center; justify-content: space-between;">
                    <div style="flex: 1; min-width: 0;">
                        <div class="settings-feed-title" style="display: flex; gap: 8px; align-items: center;">
                            <span>${escapeHtml(rule.name || 'Unnamed')}</span>
                            <span style="background: ${sevColor}; color: #000; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 600;">${(rule.severity || 'medium').toUpperCase()}</span>
                            ${enabledBadge}
                        </div>
                        <div class="settings-feed-meta">${escapeHtml(rule.mode || '')} &middot; ${escapeHtml(rule.event_type || 'any')}</div>
                    </div>
                    <div style="display: flex; gap: 4px; flex-shrink: 0;">
                        <button class="preset-btn" style="font-size: 9px; padding: 2px 6px;" onclick="AlertRulesUI.toggleRule(${rule.id}, ${!rule.enabled})">${rule.enabled ? 'Disable' : 'Enable'}</button>
                        <button class="preset-btn" style="font-size: 9px; padding: 2px 6px; color: var(--accent-red);" onclick="AlertRulesUI.deleteRule(${rule.id})">Del</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function showCreateForm() {
        const form = document.getElementById('createRuleForm');
        if (form) form.style.display = 'block';
    }

    function hideCreateForm() {
        const form = document.getElementById('createRuleForm');
        if (form) form.style.display = 'none';
        // Clear inputs
        const nameInput = document.getElementById('ruleNameInput');
        const eventInput = document.getElementById('ruleEventTypeInput');
        const matchInput = document.getElementById('ruleMatchInput');
        if (nameInput) nameInput.value = '';
        if (eventInput) eventInput.value = '';
        if (matchInput) matchInput.value = '';
    }

    function createRule() {
        const name = (document.getElementById('ruleNameInput') || {}).value || '';
        const mode = (document.getElementById('ruleModeSelect') || {}).value || '';
        const eventType = (document.getElementById('ruleEventTypeInput') || {}).value || 'device_update';
        const severity = (document.getElementById('ruleSeveritySelect') || {}).value || 'medium';
        const enabled = (document.getElementById('ruleEnabledInput') || {}).checked !== false;
        const matchStr = (document.getElementById('ruleMatchInput') || {}).value || '{}';

        if (!name) {
            alert('Please enter a rule name');
            return;
        }

        let match = {};
        try {
            match = JSON.parse(matchStr);
        } catch (e) {
            alert('Invalid JSON in match field');
            return;
        }

        fetch('/alerts/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                mode,
                event_type: eventType,
                match,
                severity,
                enabled,
                notify: { webhook: true }
            })
        })
            .then(r => r.json())
            .then(() => {
                hideCreateForm();
                loadRules();
            })
            .catch(err => console.error('[AlertRules] Create failed', err));
    }

    function toggleRule(ruleId, enabled) {
        fetch(`/alerts/rules/${ruleId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        })
            .then(r => r.json())
            .then(() => loadRules())
            .catch(err => console.error('[AlertRules] Toggle failed', err));
    }

    function deleteRule(ruleId) {
        if (!confirm('Delete this alert rule?')) return;
        fetch(`/alerts/rules/${ruleId}`, { method: 'DELETE' })
            .then(r => r.json())
            .then(() => loadRules())
            .catch(err => console.error('[AlertRules] Delete failed', err));
    }

    function saveWebhookUrl(url) {
        localStorage.setItem('valentine-webhook-url', url);
    }

    function saveNotifySetting(level, enabled) {
        localStorage.setItem(`valentine-notify-${level}`, enabled ? '1' : '0');
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    return {
        init,
        loadRules,
        showCreateForm,
        hideCreateForm,
        createRule,
        toggleRule,
        deleteRule,
        saveWebhookUrl,
        saveNotifySetting,
    };
})();

document.addEventListener('DOMContentLoaded', () => {
    if (typeof AlertRulesUI !== 'undefined') {
        AlertRulesUI.init();
    }
});
