/**
 * SAP LogServ TA - Cloud Provider UCC Hook
 *
 * Enhances the Cloud Provider configuration tab with deployment server
 * awareness, mirroring the Filters tab hook.  When the TA runs on a
 * deployment server:
 *
 *   1. A "Deploy to Forwarders" button is rendered below the form
 *   2. Server class status is shown with guidance for initial setup
 *   3. After each save, the page reloads to reflect persisted values
 *   4. The button triggers a confirmation dialog before deploying
 *
 * The cloud_provider stamp override is written to local/transforms.conf on
 * Save; the deploy push (shared /services/splunk_ta_sap_logserv/deployment_push
 * endpoint) distributes the staged deployment-apps/ copy to heavy forwarders.
 */

const PUSH_ENDPOINT =
    '/en-US/splunkd/__raw/services/splunk_ta_sap_logserv/deployment_push';

// -------------------------------------------------------------------------
// Button and notification DOM injection
// -------------------------------------------------------------------------

function createDeployUI(serverclass) {
    if (document.getElementById('logserv-cp-deploy-push-container')) {
        return;
    }

    const container = document.createElement('div');
    container.id = 'logserv-cp-deploy-push-container';
    container.style.cssText =
        'margin-top: 20px; padding: 16px; background: #fef9e7; ' +
        'border: 1px solid #f0c36d; border-radius: 4px; ' +
        'font-family: "Proxima Nova", "Helvetica Neue", Helvetica, Arial, sans-serif;';

    let serverclassHtml = '';
    if (serverclass && serverclass.exists && serverclass.disabled) {
        serverclassHtml =
            '<div style="margin-bottom: 12px; padding: 10px; ' +
            'background: #fff3cd; border: 1px solid #ffc107; border-radius: 3px; ' +
            'font-size: 13px; color: #664d03; ' +
            'font-family: \'Proxima Nova\', \'Helvetica Neue\', Helvetica, Arial, sans-serif;">' +
            '<strong>⚙ Server Class Setup Required</strong><br>' +
            'A server class <code>SAP_LogServ_HeavyForwarders</code> has been ' +
            'auto-created but is <strong>disabled</strong>. To complete setup:<br>' +
            '1. Go to <strong>Settings → Forwarder Management</strong><br>' +
            '2. Find the <code>SAP_LogServ_HeavyForwarders</code> server class<br>' +
            '3. Add client targeting (whitelist your heavy forwarder hostnames)<br>' +
            '4. Enable the server class' +
            '</div>';
    } else if (serverclass && serverclass.exists && !serverclass.disabled && !serverclass.has_clients) {
        serverclassHtml =
            '<div style="margin-bottom: 12px; padding: 10px; ' +
            'background: #fff3cd; border: 1px solid #ffc107; border-radius: 3px; ' +
            'font-size: 13px; color: #664d03; ' +
            'font-family: \'Proxima Nova\', \'Helvetica Neue\', Helvetica, Arial, sans-serif;">' +
            '<strong>⚙ Client Targeting Needed</strong><br>' +
            'Server class <code>SAP_LogServ_HeavyForwarders</code> is enabled but ' +
            'has no client targeting configured. Add a whitelist in ' +
            '<strong>Settings → Forwarder Management</strong> to specify which ' +
            'heavy forwarders should receive this TA.' +
            '</div>';
    }

    container.innerHTML =
        '<div style="margin-bottom: 10px; font-weight: 600; color: #6d4c00;">' +
        '⚠ Deployment Server Detected' +
        '</div>' +
        '<div style="margin-bottom: 12px; color: #333; font-size: 13px;">' +
        'The cloud_provider attribution override has been staged to ' +
        '<code>deployment-apps/</code>. Deploy to distribute the change to ' +
        'heavy forwarders.' +
        '</div>' +
        serverclassHtml +
        '<button id="logserv-cp-deploy-btn" type="button" ' +
        'style="padding: 8px 16px; background: #5c6773; color: #fff; ' +
        'border: none; border-radius: 3px; cursor: pointer; font-size: 13px;">' +
        'Deploy to Forwarders' +
        '</button>' +
        '<span id="logserv-cp-deploy-status" style="margin-left: 12px; font-size: 13px;"></span>';

    // Scope the banner to THIS tab's panel. Both Configuration tab panels
    // (Filters + Cloud Provider) are mounted in the DOM at once — only the
    // active one is visible — so any document-global [data-test=...] query
    // resolves to the first/active tab. That is why this banner previously
    // landed on the Filters tab. Anchor on a field unique to the Cloud
    // Provider tab, walk up to the nearest ancestor that also contains a Save
    // button (that ancestor is this tab's own form), and insert there.
    const anchorField = document.querySelector('[data-name="cloud_provider"]');
    let tabRoot = null;
    let node = anchorField;
    while (node && node !== document.body) {
        if (node.querySelector('[data-test="button"]')) {
            tabRoot = node;
            break;
        }
        node = node.parentElement;
    }

    if (!tabRoot) {
        // Cloud Provider tab not rendered yet — don't risk injecting into the
        // wrong tab. A later onRender will retry once the panel is in the DOM.
        return;
    }

    const saveBtn = tabRoot.querySelector('[data-test="button"]');
    if (saveBtn) {
        const saveBtnRow = saveBtn.closest('.formRow') || saveBtn.parentNode;
        saveBtnRow.parentNode.insertBefore(container, saveBtnRow.nextSibling);
    } else {
        tabRoot.appendChild(container);
    }

    const btn = document.getElementById('logserv-cp-deploy-btn');
    if (btn) {
        btn.addEventListener('click', handleDeployClick);
    }
}

function removeDeployUI() {
    const el = document.getElementById('logserv-cp-deploy-push-container');
    if (el) el.remove();
}

// -------------------------------------------------------------------------
// Deploy action
// -------------------------------------------------------------------------

async function handleDeployClick() {
    const confirmed = window.confirm(
        'Deploy the cloud_provider attribution to all heavy forwarders?\n\n' +
        'This triggers a reload of the app on the deployment server. ' +
        'Forwarders will pick up the updated configuration on their ' +
        'next phone-home interval.\n\n' +
        'Proceed?'
    );

    if (!confirmed) return;

    const btn = document.getElementById('logserv-cp-deploy-btn');
    const status = document.getElementById('logserv-cp-deploy-status');

    btn.disabled = true;
    btn.textContent = 'Deploying…';
    status.textContent = '';
    status.style.color = '#333';

    try {
        const response = await fetch(PUSH_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Splunk-Form-Key': getSplunkFormKey(),
                'X-Requested-With': 'XMLHttpRequest',
            },
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok && data.success) {
            status.textContent = '✓ ' + data.message;
            status.style.color = '#2e7d32';
        } else {
            status.textContent = '✗ ' + (data.error || 'Deployment failed');
            status.style.color = '#c62828';
        }
    } catch (err) {
        status.textContent = '✗ Request failed: ' + err.message;
        status.style.color = '#c62828';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Deploy to Forwarders';
    }
}

function getSplunkFormKey() {
    const match = document.cookie.match(/splunkweb_csrf_token_\d+=([^;]+)/);
    return match ? match[1] : '';
}

// -------------------------------------------------------------------------
// Deployment server detection
// -------------------------------------------------------------------------

async function checkDeploymentServer() {
    try {
        const response = await fetch(PUSH_ENDPOINT + '?output_mode=json', {
            method: 'GET',
            headers: {
                'X-Splunk-Form-Key': getSplunkFormKey(),
                'X-Requested-With': 'XMLHttpRequest',
            },
            credentials: 'include',
        });

        if (response.ok) {
            return await response.json();
        }
    } catch (err) {
        console.warn('LogServ: Could not check deployment server status:', err);
    }
    return null;
}

// -------------------------------------------------------------------------
// UCC Hook class
// -------------------------------------------------------------------------

class CloudProviderHook {
    constructor(globalConfig, serviceName, model, util) {
        this._isDeploymentServer = false;
    }

    onCreate() {
        this._checkAndRender();
    }

    onRender() {
        this._checkAndRender();
    }

    onEditLoad() {
        this._checkAndRender();
    }

    onSaveSuccess() {
        setTimeout(() => {
            window.location.reload();
        }, 500);
    }

    onSaveFail() {
        // no-op
    }

    async _checkAndRender() {
        if (this._checkInProgress) return;
        this._checkInProgress = true;

        try {
            const data = await checkDeploymentServer();
            this._isDeploymentServer = data && data.is_deployment_server === true;
            if (this._isDeploymentServer) {
                const serverclass = data.serverclass || null;
                setTimeout(() => createDeployUI(serverclass), 300);
            } else {
                removeDeployUI();
            }
        } finally {
            this._checkInProgress = false;
        }
    }
}

export default CloudProviderHook;
