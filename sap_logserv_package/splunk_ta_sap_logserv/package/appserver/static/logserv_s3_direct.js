/**
 * SAP LogServ TA — AWS S3 Direct (Generic S3 backfill / recovery screen)
 *
 * Creates and manages LogServ-scoped Generic S3 inputs (aws_s3://) inside
 * Splunk_TA_aws, from the signed-in user's browser session. Secondary channel:
 * SQS-Based S3 remains the steady-state path. This exists for backfill,
 * queue-less buckets and outage recovery.
 *
 * Design: logserv_s3_input_screen_design_v0.2_20260909.md, as corrected by the
 * session-117 adversarial review folded at that note's section 17a. Every
 * numbered reference below (B1..B8, L1-nn, L2-nn, L3-nn) points into 17a.
 *
 * Section 18 of the same note (session 135) replaced the create form: the
 * operator picks dashboards - the App's Settings -> Dashboard Data rows - and a
 * range of UTC days, and the screen builds one input per S3 folder and year,
 * each selecting its exact day partitions with a whitelist. The two dates now
 * select the date IN THE KEY, not the object's write time; the write-time
 * window is fixed by the screen (18.2). There is no edit path any more (18.1).
 *
 * Why this is a standalone view and not a third Configuration tab (17a, B1):
 * UCC serves every configuration tab from one MultipleModel and one handler.
 * FilterSettingsHandler.handleEdit dispatches on FIELD PRESENCE, so a third
 * tab's payload (no filter_enabled) reads as filter_enabled=False and
 * _generate_filter_configs then CLEARS local/transforms.conf + local/props.conf
 * and mirrors the cleared files to deployment-apps/. A standalone view never
 * touches that handler, so the Data TA needs no Python change.
 *
 * Security boundaries — the four encoders. Validation patterns are UX gates a
 * user can bypass in devtools (L2-13); these always execute:
 *   enc()        every REST body field and every data-derived path segment
 *   shq()        every value interpolated into the generated shell command
 *   confValue()  every value interpolated into the generated conf stanza
 *   textContent  every value rendered into the DOM
 *
 * There is deliberately no HTML-escape helper here. Every value reaches the
 * DOM through textContent, so one is never needed — and an available esc()
 * invites use in a REST body, a shell command or a conf value, where
 * HTML-escaping is the WRONG encoding and silently corrupts the value
 * (17a, L2-03).
 */
/*
 * Loaded as a plain script, NOT as an AMD module (session-117 rendered pass).
 *
 * The first version wrapped everything in an anonymous define(). Splunk 9.4's
 * loader does fetch and evaluate a dashboard's script= asset, but it never
 * attributes an anonymous define() from one to a module name: it queues the
 * factory, then rejects it with RequireJS's "Mismatched anonymous define()
 * module". The file loaded, the factory never ran, and the panel sat on its
 * "Loading…" placeholder with nothing visibly wrong on the page — the only
 * trace was that one console error. A self-executing function has no such
 * dependency: the body runs the moment the file is evaluated.
 *
 * Confirmed on hf-01 by removing the define() and changing nothing else: the
 * screen renders from script= alone. No define() call is made now — nothing in
 * the app depends on this module, and a second anonymous define() would only
 * re-raise the same loader error in the customer's console.
 */
(function () {
    'use strict';

    /*
     * Idempotence. Splunk loads this once per page, but the file is also
     * require()-able by hand, and a loader change could evaluate it twice —
     * which did happen while the load path above was being diagnosed. Booting
     * twice would render the screen twice into the same panel.
     */
    var LOADED_FLAG = '__logservS3DirectLoaded';
    if (window[LOADED_FLAG]) { return; }

    /* ---------------------------------------------------------------- *
     * Constants
     * ---------------------------------------------------------------- */

    var PROXY = '/en-US/splunkd/__raw';
    var AWS_NS = PROXY + '/servicesNS/nobody/Splunk_TA_aws';
    var TA_NS = PROXY + '/servicesNS/nobody/splunk_ta_sap_logserv';
    var S3_EP = AWS_NS + '/splunk_ta_aws_aws_s3';
    var SQS_EP = AWS_NS + '/splunk_ta_aws_aws_sqs_based_s3';
    var ACCOUNTS_EP = AWS_NS + '/splunk_ta_aws_aws_all_accounts';
    var ROLES_EP = AWS_NS + '/splunk_ta_aws_iam_roles';
    /* The cloud_provider stamp goes through this TA's own endpoint (section
     * 18.11). Measured on hf-01 in session 136: the browser cannot reach the
     * add-on's native data/inputs/aws_s3 endpoint at all (Splunk Web's
     * /splunkd/__raw proxy only passes endpoints some app exposes in web.conf,
     * and the add-on exposes only its UCC endpoints), and that endpoint refuses
     * _meta anyway (HTTP 400 "not supported by this handler"). The TA endpoint
     * writes the stamp into the stanza server-side and restarts the input.
     * Enable/disable go through the UCC endpoint's disabled field. */
    var META_EP = PROXY + '/services/splunk_ta_sap_logserv/s3_direct_meta';

    var CURRENT_CONTEXT = PROXY + '/services/authentication/current-context';
    var SERVER_INFO = PROXY + '/services/server/info';
    var APPS_LOCAL = PROXY + '/services/apps/local';
    var INDEXES_EP = PROXY + '/services/data/indexes';
    var DEPLOY_PUSH = PROXY + '/services/splunk_ta_sap_logserv/deployment_push';
    var DEPLOY_CLIENT = PROXY + '/services/deployment/client/serverclasses';
    var FILTER_SETTINGS =
        TA_NS + '/splunk_ta_sap_logserv_settings/filter_settings';

    /* Validated against this exact add-on version. A minor release can move
     * field names, defaults and handler behaviour, and three of the four
     * create/update asymmetries actually originate in splunktaucclib, which
     * the add-on upgrades independently (L1-07, L1-08). Exact-version
     * allowlist, advisory banner on anything else. The whitelist semantics
     * and the terminal-time behaviour section 18 relies on were read from
     * 8.1.0's source. */
    var VALIDATED_TA_AWS_VERSIONS = ['8.1.0'];

    var NAME_PREFIX = 'logserv_backfill_';
    var KEY_ROOT = 'logserv/';

    /* Vendor default. NOT a safety cap: max_items is declared in the input
     * scheme and never read by the 8.1.0 loader, so it bounds nothing
     * (L3-10). Blast radius is controlled by the per-folder, per-year input
     * split, the whitelist, and the 366-day span limit (section 18.3). */
    var MAX_ITEMS = '100000';

    /* The write-time lower bound every input gets (section 18.2).
     *
     * NOT the Unix epoch, deliberately. The add-on resolves the scan dates
     * through Splunk's OWN search/timeparser at RUNTIME
     * (aws_s3_conf.py::_get_last_modified_time -> ta_aws_common.py::parse_datetime),
     * while CREATE validates locally with strptime. Splunk 9.4.3 REJECTS every
     * 1970 date - measured on splunk-hf-01: GET
     * search/timeparser?time=1970-01-01T00:00:00Z returns HTTP 400
     * <msg type="FATAL">Invalid time.</msg>, and 1971-01-01T00:00:00Z is the
     * first accepted value. So a 1970 floor SAVES cleanly, the screen reports
     * success, and the input then raises on every poll: zero events, forever.
     *
     * 2000-01-01 is below any object S3 can hold (S3 launched in 2006) and
     * clear of the cliff, so it is an effective "every write time" that the
     * server will actually parse. SAP re-stages archives - objects carrying
     * 2025-06-11 events have LastModified 2026-01-26 - so any narrower lower
     * bound can silently select nothing. */
    var SCAN_FLOOR = '2000-01-01T00:00:00Z';

    /* The write-time UPPER bound is the moment of creation plus this margin
     * (section 18.2). The add-on records a scan as finished once a discovery
     * pass that started after the terminal time completes - even one cut short
     * by a stop - and a finished input returns BEFORE fetching. With no margin
     * the first pass is also the last, so a forwarder restart mid-fetch (every
     * filter push from the deployment server restarts both forwarders) would
     * strand every discovered-but-unfetched object. A day out, the next run
     * resumes the fetch from the add-on's own checkpoints, and the input still
     * stops by itself. */
    var TERMINAL_MARGIN_MS = 86400000;

    /* No longer on the form: with a fixed, near terminal time the interval only
     * paces the re-listings of a closed partition. */
    var POLL_SECONDS = '1800';

    var DAY_MS = 86400000;

    /* The earliest Scan from the form accepts: the date part of SCAN_FLOOR. */
    var DATE_FLOOR = '2000-01-01';

    /* Bounds the input count: one input per folder per calendar year, so a
     * span of at most 366 days touches at most two years - at most 64 inputs
     * for a row that reads all 32 folders. */
    var MAX_SPAN_DAYS = 366;

    /* Today and this many days before it are probably still being delivered
     * by the SQS-Based S3 input (L3-09: a partition whose last instant is at
     * most two days old). */
    var SQS_RECENT_DAYS = 2;

    /* The 32 clz_dir/clz_subdir pairs the Data TA routes, from the
     * @logserv_filter annotations in default/transforms.conf. Four contain a
     * colon, which every validator and encoder on this screen must tolerate
     * (L3-14, and 17a.4 — a proposed review fix got this wrong). The App build
     * checks this list against the Data TA's routed set (section 18.8). */
    var CLZ_PAIRS = [
        'abap/audit', 'abap/dispatcher', 'abap/enqueueserver', 'abap/event',
        'abap/gateway', 'abap/icm', 'abap/messageserver', 'abap/sapstartsrv',
        'abap/workprocess', 'dns/binddns', 'hana/hanaaudit', 'hana/tracelogs',
        'linux/cron', 'linux/linux_secure', 'linux/localmessages',
        'linux/messages', 'linux/pacemaker', 'linux/proxy', 'linux/slapd',
        'linux/sudolog', 'linux/warn',
        'proxy/squid', 'sap/saphostexec', 'sap/saprouter', 'sap/sapstartsrv',
        'scc/audit', 'scc/tracelogs', 'webdispatcher/accesslog',
        'windows/WinEventLog:Application', 'windows/WinEventLog:Powershell',
        'windows/WinEventLog:Security', 'windows/WinEventLog:System'
    ];

    /* The App's Settings -> Dashboard Data rows, and the S3 folders each is
     * built from (section 18.3). GENERATED - do not edit by hand. The App build
     * (bin/check-diagnostics.js) re-derives this from routes/rollupRegistry x
     * utils/diagEvidence.extractAggregateScope x utils/diagIngestFacts
     * (SOURCETYPE_CLZ_MAP, TAG_CLZ_MAP) and fails on any difference, so it is
     * strict JSON between the markers: that gate reads it without evaluating
     * this file. Ordered as the App orders its rows (label, localeCompare). */
    /* BEGIN ROLLUP_FOLDERS */
    var ROLLUP_FOLDERS = [
        {"key": "abapnet", "label": "ABAP Network & Security", "folders": ["abap/audit", "abap/gateway", "abap/icm"]},
        {"key": "beaconing", "label": "Beaconing detection (Environment Health / DNS / Network Perimeter)", "folders": ["dns/binddns", "linux/proxy", "proxy/squid"]},
        {"key": "compliance", "label": "Change & Configuration Activity", "folders": ["hana/hanaaudit", "linux/cron", "linux/linux_secure", "linux/localmessages", "linux/messages", "linux/pacemaker", "linux/proxy", "linux/slapd", "linux/sudolog", "linux/warn", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "cloudconn", "label": "Cloud Connector", "folders": ["scc/audit", "scc/tracelogs"]},
        {"key": "xstack_auth", "label": "Cross-Stack Authentication", "folders": ["hana/hanaaudit", "sap/sapstartsrv", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "pipeline", "label": "Data Pipeline Overview", "folders": ["abap/audit", "abap/dispatcher", "abap/enqueueserver", "abap/event", "abap/gateway", "abap/icm", "abap/messageserver", "abap/sapstartsrv", "abap/workprocess", "dns/binddns", "hana/hanaaudit", "hana/tracelogs", "linux/cron", "linux/linux_secure", "linux/localmessages", "linux/messages", "linux/pacemaker", "linux/proxy", "linux/slapd", "linux/sudolog", "linux/warn", "proxy/squid", "sap/saphostexec", "sap/saprouter", "sap/sapstartsrv", "scc/audit", "scc/tracelogs", "webdispatcher/accesslog", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "dns", "label": "DNS Analytics", "folders": ["dns/binddns"]},
        {"key": "severity", "label": "Environment Health", "folders": ["abap/dispatcher", "abap/gateway", "abap/icm", "hana/hanaaudit", "hana/tracelogs", "linux/linux_secure", "linux/proxy", "proxy/squid", "sap/saprouter", "sap/sapstartsrv", "scc/audit", "scc/tracelogs", "webdispatcher/accesslog", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "topology_detail", "label": "Environment Topology (detail tabs)", "folders": ["abap/gateway", "abap/icm", "hana/hanaaudit", "hana/tracelogs", "webdispatcher/accesslog"]},
        {"key": "topology_graph", "label": "Environment Topology (graph)", "folders": ["abap/gateway", "abap/icm", "hana/hanaaudit", "hana/tracelogs", "linux/linux_secure", "linux/localmessages", "linux/messages", "linux/proxy", "sap/sapstartsrv", "webdispatcher/accesslog", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "hana", "label": "HANA Audit", "folders": ["hana/hanaaudit"]},
        {"key": "hana_trace", "label": "HANA Trace", "folders": ["hana/tracelogs"]},
        {"key": "hostdetails", "label": "Host Details", "folders": ["abap/audit", "abap/dispatcher", "abap/enqueueserver", "abap/event", "abap/gateway", "abap/icm", "abap/messageserver", "abap/sapstartsrv", "abap/workprocess", "dns/binddns", "hana/hanaaudit", "hana/tracelogs", "linux/cron", "linux/linux_secure", "linux/localmessages", "linux/messages", "linux/pacemaker", "linux/proxy", "linux/slapd", "linux/sudolog", "linux/warn", "proxy/squid", "sap/saphostexec", "sap/saprouter", "sap/sapstartsrv", "scc/audit", "scc/tracelogs", "webdispatcher/accesslog", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "hostrole", "label": "Host Role Activity (Host Details)", "folders": ["abap/workprocess", "dns/binddns", "hana/hanaaudit", "linux/localmessages", "linux/messages", "linux/proxy", "sap/saprouter", "webdispatcher/accesslog", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "linux", "label": "Linux System & Security", "folders": ["linux/cron", "linux/linux_secure", "linux/localmessages", "linux/messages", "linux/pacemaker", "linux/proxy", "linux/slapd", "linux/sudolog", "linux/warn"]},
        {"key": "mc", "label": "Multi-Cloud Overview", "folders": ["abap/audit", "abap/dispatcher", "abap/enqueueserver", "abap/event", "abap/gateway", "abap/icm", "abap/messageserver", "abap/sapstartsrv", "abap/workprocess", "dns/binddns", "hana/hanaaudit", "hana/tracelogs", "linux/cron", "linux/linux_secure", "linux/localmessages", "linux/messages", "linux/pacemaker", "linux/proxy", "linux/slapd", "linux/sudolog", "linux/warn", "proxy/squid", "sap/saphostexec", "sap/saprouter", "sap/sapstartsrv", "scc/audit", "scc/tracelogs", "webdispatcher/accesslog", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "perimeter", "label": "Network Perimeter", "folders": ["dns/binddns", "linux/linux_secure", "linux/proxy", "proxy/squid"]},
        {"key": "proxy", "label": "Proxy Analytics", "folders": ["linux/proxy", "proxy/squid"]},
        {"key": "saprouter", "label": "SAP Router", "folders": ["sap/saprouter"]},
        {"key": "sapservices", "label": "SAP Services", "folders": ["sap/saphostexec", "sap/sapstartsrv"]},
        {"key": "stmap", "label": "Sourcetype Mapping (Host Details / Data Pipeline)", "folders": ["abap/audit", "abap/dispatcher", "abap/enqueueserver", "abap/event", "abap/gateway", "abap/icm", "abap/messageserver", "abap/sapstartsrv", "abap/workprocess", "dns/binddns", "hana/hanaaudit", "hana/tracelogs", "linux/cron", "linux/linux_secure", "linux/localmessages", "linux/messages", "linux/pacemaker", "linux/proxy", "linux/slapd", "linux/sudolog", "linux/warn", "proxy/squid", "sap/saphostexec", "sap/saprouter", "sap/sapstartsrv", "scc/audit", "scc/tracelogs", "webdispatcher/accesslog", "windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "web_timing", "label": "Web & API Performance / Web Dispatcher", "folders": ["scc/tracelogs", "webdispatcher/accesslog"]},
        {"key": "webdisp_slowtrace", "label": "Web Dispatcher Slowest Traces", "folders": ["webdispatcher/accesslog"]},
        {"key": "windows", "label": "Windows", "folders": ["windows/WinEventLog:Application", "windows/WinEventLog:Powershell", "windows/WinEventLog:Security", "windows/WinEventLog:System"]},
        {"key": "wp_perf", "label": "Work Process Performance / ABAP Operations", "folders": ["abap/dispatcher", "abap/enqueueserver", "abap/event", "abap/icm", "abap/messageserver", "abap/sapstartsrv", "abap/workprocess"]}
    ];
    /* END ROLLUP_FOLDERS */

    var SOURCETYPE = 'sap_logserv_logs';
    var ACK_KEY_BASE = 'logserv.s3direct.tierAck.';

    /* The panel div declared by the view. Splunk inserts it asynchronously,
     * so start() polls for it — see the note there. 20 s of headroom. */
    var ROOT_ID = 'logserv-s3-direct-root';
    var ROOT_POLL_MS = 100;
    var MAX_ROOT_TRIES = 200;

    /* ---------------------------------------------------------------- *
     * Encoders — the security boundaries
     * ---------------------------------------------------------------- */

    function enc(v) {
        return encodeURIComponent(v === null || v === undefined ? '' : String(v));
    }

    /** Form-encode a flat object. Every key and value encoded (L2-03, L2-10):
     *  a bare '&' in a value would otherwise inject a second parameter and
     *  could override the sourcetype this screen exists to guarantee. */
    function formEncode(obj) {
        var out = [];
        Object.keys(obj).forEach(function (k) {
            if (obj[k] === undefined || obj[k] === null) { return; }
            out.push(enc(k) + '=' + enc(obj[k]));
        });
        return out.join('&');
    }

    /** One REST path segment. encodeURIComponent turns '/' into %2F, which is
     *  what defeats a planted '../' input name collapsing in the URL parser
     *  and re-targeting the request (L2-02 / B4). */
    function pathSeg(v) {
        return enc(v);
    }

    /** Single-quote for a POSIX shell. The only escape inside '...' is '\'' .
     *  Mode 2's command is pasted by an administrator, so this is the boundary
     *  that matters most (L2-01 / B3). */
    function shq(v) {
        var s = String(v === null || v === undefined ? '' : v);
        if (/[\x00-\x1f\x7f]/.test(s)) {
            throw new Error('control character in value');
        }
        return "'" + s.split("'").join("'\\''") + "'";
    }

    /** A value safe to place after '<key> = ' in a .conf file. A trailing
     *  backslash is a legal S3 key character AND a conf line continuation,
     *  which would swallow the following sourcetype line and produce exactly
     *  the unrouted-data failure this screen exists to prevent (L2-06). */
    function confValue(v) {
        var s = String(v === null || v === undefined ? '' : v);
        if (/[\r\n\x00]/.test(s)) {
            throw new Error('control character in conf value');
        }
        if (/\\$/.test(s)) {
            throw new Error('value ends in a backslash, which continues the conf line');
        }
        return s;
    }

    function confStanzaName(v) {
        var s = String(v || '');
        if (!/^[A-Za-z0-9._\-\/]{1,255}$/.test(s)) {
            throw new Error('unsafe stanza name');
        }
        return s;
    }

    /* ---------------------------------------------------------------- *
     * DOM helpers — createElement/textContent only
     * ---------------------------------------------------------------- */

    function el(tag, attrs, kids) {
        var node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                if (k === 'text') { node.textContent = attrs[k]; }
                else if (k === 'cls') { node.className = attrs[k]; }
                else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
                    node.addEventListener(k.slice(2), attrs[k]);
                } else if (attrs[k] !== null && attrs[k] !== undefined) {
                    node.setAttribute(k, attrs[k]);
                }
            });
        }
        (kids || []).forEach(function (c) {
            if (c === null || c === undefined) { return; }
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
    }

    function clear(node) {
        while (node.firstChild) { node.removeChild(node.firstChild); }
    }

    /* ---------------------------------------------------------------- *
     * Transport
     * ---------------------------------------------------------------- */

    /** Scope the CSRF cookie to THIS Splunk Web instance. An unscoped match
     *  takes the first splunkweb_csrf_token_<port> cookie in document.cookie
     *  order, which on a host running two instances can be the other one's
     *  token — a 401 loop no retry can fix (L2-09). */
    function formKey() {
        var port = window.location.port || '80';
        var scoped = document.cookie.match(
            new RegExp('splunkweb_csrf_token_' + port + '=([^;]+)')
        );
        var any = scoped || document.cookie.match(/splunkweb_csrf_token_[0-9]+=([^;]+)/);
        return any ? decodeURIComponent(any[1]) : '';
    }

    function parseJson(text) {
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    /**
     * One REST call.
     *
     * Retry policy (L2-09, L3-04): retry at most once, only on a 401 whose
     * body mentions CSRF, and only when the caller opts in. Creates NEVER opt
     * in — a create that timed out may in fact have succeeded, and a retry
     * would produce a second input on the same keys, which genuinely
     * double-ingests because the checkpoint is keyed on the input name.
     */
    function req(url, opts, retryOnCsrf) {
        opts = opts || {};
        var init = {
            method: opts.method || 'GET',
            credentials: 'include',
            headers: {
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        if (init.method !== 'GET') {
            init.headers['X-Splunk-Form-Key'] = formKey();
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            if (opts.body !== undefined) { init.body = opts.body; }
        }
        var sep = url.indexOf('?') === -1 ? '?' : '&';
        return fetch(url + sep + 'output_mode=json', init).then(function (res) {
            return res.text().then(function (text) {
                if (res.status === 401 && retryOnCsrf && /csrf/i.test(text)) {
                    return req(url, opts, false);
                }
                return { status: res.status, ok: res.ok, text: text, json: parseJson(text) };
            });
        });
    }

    function entries(resp) {
        return (resp && resp.json && resp.json.entry) ? resp.json.entry : [];
    }

    /**
     * Translate a failure into something true and useful, without reflecting
     * raw vendor bodies or tracebacks to the viewer (L2-14, and section 9 of
     * the design). Full detail goes to the console for an admin only.
     */
    function explain(resp) {
        var t = resp.text || '';
        if (resp.status === 403 || /admin_all_objects/.test(t)) {
            return 'Your account lacks the admin_all_objects capability, which Splunk ' +
                'requires for this write. Use the generated stanzas below instead.';
        }
        if (resp.status === 500 && /403|forbidden/i.test(t)) {
            return 'Your account lacks the admin_all_objects capability (the add-on ' +
                'reported it as a 500). Use the generated stanzas below instead.';
        }
        if (resp.status === 401) { return 'Session or CSRF token rejected. Reload the page and retry.'; }
        /* The vendor's message is "Required field is missing: <name>", which
         * the original pattern did not match - so a missing required field
         * surfaced as the generic HTTP 400 fallback. */
        if (/required (arguments are missing|field is missing)/i.test(t)) {
            return 'The add-on rejected the payload as incomplete. This is a bug in this screen — ' +
                'please report it; nothing was changed.';
        }
        if (/is not supported by this handler/i.test(t)) {
            return 'The add-on rejected a field this screen sent. This is a bug in this screen — ' +
                'please report it; nothing was changed.';
        }
        /* The scan window is generated now (section 18.2), so a datetime the
         * add-on refuses is this screen's fault, not the operator's. */
        if (/Wrong datetime|Invalid datetime range/i.test(t)) {
            return 'The add-on rejected the scan window this screen generated. This is a bug in ' +
                'this screen — please report it; nothing was changed.';
        }
        return 'The request failed (HTTP ' + resp.status + '). See the browser console for detail.';
    }

    /* ---------------------------------------------------------------- *
     * Validation patterns — UX gates. The encoders above are the real boundary.
     * ---------------------------------------------------------------- */

    /* The job name. No underscore: it separates the parts of every input name
     * (logserv_backfill_<job>_<folder-slug>_<year>), and a job name containing
     * one would make those names ambiguous to parse back (section 18.3). */
    var RE_JOB = /^[a-z0-9][a-z0-9-]{0,23}$/;
    var RE_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
    var RE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
    var RE_DATETIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
    var RE_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

    /* Colon is required: logserv/windows/WinEventLog:Security/... is a real
     * prefix. '+' is legal in an S3 key too (17a.4). Still applied to the key
     * prefix of every record reconstructed from the add-on (recordIssues). */
    var RE_KEY_NAME = /^logserv\/(?:[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}\/)*(?:[A-Za-z0-9][A-Za-z0-9._:+-]{0,127})?$/;

    /* A name this screen's section-18 form produced:
     *   logserv_backfill_<job>_<folder-slug>_<YYYY> */
    var RE_OUR_NAME = /^logserv_backfill_([a-z0-9][a-z0-9-]{0,23})_([a-z0-9_]+)_([0-9]{4})$/;

    /* The canonical whitelist, as buildWhitelist writes it. Parsing is only the
     * first half of recognising one: parseCanonical then REGENERATES it from
     * what it parsed and requires the same string back (section 18.4). */
    var RE_WHITELIST = /^\^logserv\/(.+)\/([0-9]{4})\/\(\?:(.+)\)\/\.\+\$$/;
    var RE_WL_MONTH = /^([0-9]{2})\/\(\?:([0-9]{2}(?:\|[0-9]{2})*)\)$/;

    /* ---------------------------------------------------------------- *
     * UTC calendar dates
     *
     * The two dates select S3 key partitions, and those are named in UTC. A
     * date is carried as the string 'YYYY-MM-DD' end to end - <input
     * type="date"> produces exactly that, zone-less - and is only ever turned
     * into an instant with Date.UTC. Nothing here reads the viewer's local
     * date: the no-conversion invariant of section 17c, for the same reason.
     * ---------------------------------------------------------------- */

    /** Wire form for a Date, in UTC: YYYY-MM-DDTHH:MM:SSZ. */
    function isoZ(d) {
        return d.toISOString().slice(0, 19) + 'Z';
    }

    function utcDateString(ms) {
        return new Date(ms).toISOString().slice(0, 10);
    }

    /** 'YYYY-MM-DD' -> the epoch ms of that UTC midnight, or null when the
     *  string is not a real calendar date. Round-trips through Date, so
     *  2026-02-30 is refused rather than rolled into March, and a two-digit
     *  year (which Date.UTC maps into the 1900s) cannot sneak through. */
    function parseUtcDate(s) {
        var v = String(s === null || s === undefined ? '' : s);
        if (!RE_DATE.test(v)) { return null; }
        var t = Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10)));
        if (isNaN(t)) { return null; }
        return utcDateString(t) === v ? t : null;
    }

    function todayUtc() {
        return utcDateString(Date.now());
    }

    /** Every UTC date from one midnight to another, inclusive. UTC days are all
     *  exactly DAY_MS long, so stepping by it never skips or repeats one. */
    function enumerateDays(fromMs, untilMs) {
        var out = [];
        for (var t = fromMs; t <= untilMs; t += DAY_MS) { out.push(utcDateString(t)); }
        return out;
    }

    /* ---------------------------------------------------------------- *
     * Folders, key prefixes, whitelists and names (section 18.3)
     * ---------------------------------------------------------------- */

    function rowByKey(key) {
        for (var i = 0; i < ROLLUP_FOLDERS.length; i++) {
            if (ROLLUP_FOLDERS[i].key === key) { return ROLLUP_FOLDERS[i]; }
        }
        return null;
    }

    /** The union of the chosen rows' folders, sorted, each once. */
    function foldersFor(rowKeys) {
        var seen = {};
        var out = [];
        (rowKeys || []).forEach(function (k) {
            var r = rowByKey(k);
            if (!r) { return; }
            r.folders.forEach(function (f) {
                if (!seen[f]) { seen[f] = true; out.push(f); }
            });
        });
        return out.sort();
    }

    /** 'windows/WinEventLog:Security' -> 'windows_wineventlog_security'. */
    function folderSlug(folder) {
        return String(folder).toLowerCase().replace(/[\/:]/g, '_');
    }

    function reEscape(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** The tightest prefix holding every day (all in one calendar year):
     *  the day itself, else its month, else its year. */
    function keyPrefixFor(folder, days) {
        var base = KEY_ROOT + folder + '/';
        if (days.length === 1) { return base + days[0].replace(/-/g, '/') + '/'; }
        var month = days[0].slice(0, 7);
        var oneMonth = days.every(function (d) { return d.slice(0, 7) === month; });
        if (oneMonth) { return base + month.replace('-', '/') + '/'; }
        return base + days[0].slice(0, 4) + '/';
    }

    /**
     * The canonical whitelist for one folder and its sorted days (one year):
     *
     *   ^logserv/<folder>/<YYYY>/(?:<MM>/(?:<DD>|<DD>)|<MM>/(?:<DD>))/.+$
     *
     * The add-on compiles it with Python's re and matches with re.search
     * against the FULL key, appending $ only when it is absent
     * (aws_s3_common.py::_build_regex / _match_regex). So both anchors are
     * written out, and the pattern runs to the end of the key: the day folder,
     * then at least one character of object name below it.
     */
    function buildWhitelist(folder, days) {
        var months = [];
        days.forEach(function (d) {
            var mm = d.slice(5, 7);
            var dd = d.slice(8, 10);
            var last = months[months.length - 1];
            if (last && last.mm === mm) { last.dds.push(dd); } else { months.push({ mm: mm, dds: [dd] }); }
        });
        return '^' + reEscape(KEY_ROOT + folder + '/' + days[0].slice(0, 4) + '/') + '(?:' +
            months.map(function (m) { return m.mm + '/(?:' + m.dds.join('|') + ')'; }).join('|') +
            ')/.+$';
    }

    function inputName(job, folder, year) {
        return NAME_PREFIX + job + '_' + folderSlug(folder) + '_' + year;
    }

    /**
     * Recognise an input this screen's section-18 form made, and read back the
     * folder-days it covers. The name must parse, the whitelist must parse,
     * and then BOTH must regenerate byte for byte from what was parsed - so a
     * hand-edited or foreign whitelist is never mistaken for one of ours, and
     * never trusted as proof that a day was read. Returns null otherwise.
     */
    function parseCanonical(rec) {
        var nm = RE_OUR_NAME.exec(String(rec.name || ''));
        if (!nm) { return null; }
        var wl = String(rec.whitelist || '');
        var m = RE_WHITELIST.exec(wl);
        if (!m) { return null; }
        var folder = m[1];
        var year = m[2];
        if (CLZ_PAIRS.indexOf(folder) === -1) { return null; }
        if (folderSlug(folder) !== nm[2] || year !== nm[3]) { return null; }
        var days = [];
        var parts = m[3].split(')|');
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i] + (i < parts.length - 1 ? ')' : '');
            var mm = RE_WL_MONTH.exec(part);
            if (!mm) { return null; }
            var dds = mm[2].split('|');
            for (var j = 0; j < dds.length; j++) {
                var day = year + '-' + mm[1] + '-' + dds[j];
                if (parseUtcDate(day) === null) { return null; }
                if (days.length && day <= days[days.length - 1]) { return null; }
                days.push(day);
            }
        }
        if (!days.length) { return null; }
        if (buildWhitelist(folder, days) !== wl) { return null; }
        if (keyPrefixFor(folder, days) !== String(rec.key_name || '')) { return null; }
        return { job: nm[1], folder: folder, year: year, days: days };
    }

    /* The date partition a LogServ prefix carries, if it carries one:
     *  logserv/<clz_dir>/<clz_subdir>/YYYY[/MM[/DD]]/
     *
     *  Returns { start, end, label, granularity } or null. Used to judge
     *  inputs this screen did not make (section 18.4): their prefix says which
     *  days they COULD have read. A month that is present but out of range is
     *  a typo rather than a year partition, and a day Date.UTC would roll into
     *  the next month names a day nobody wrote - both are refused. */
    function segmentsOf(prefix) {
        return String(prefix || '').split('/').filter(function (s) { return s !== ''; });
    }

    function prefixDate(prefix) {
        var s = segmentsOf(prefix);
        if (s.length < 4) { return null; }
        var y = s[3], m = s[4], d = s[5];
        if (!/^[0-9]{4}$/.test(y)) { return null; }
        var Y = Number(y), M = null, D = null;
        if (s.length >= 5) {
            if (!/^[0-9]{2}$/.test(m)) { return null; }
            M = Number(m);
            if (M < 1 || M > 12) { return null; }
        }
        if (s.length >= 6) {
            if (!/^[0-9]{2}$/.test(d)) { return null; }
            D = Number(d);
        }
        var start, end, label, granularity;
        if (D !== null) {
            start = new Date(Date.UTC(Y, M - 1, D));
            end = new Date(Date.UTC(Y, M - 1, D, 23, 59, 59, 999));
            if (start.getUTCMonth() !== M - 1 || start.getUTCDate() !== D) { return null; }
            label = y + '-' + m + '-' + d;
            granularity = 'day';
        } else if (M !== null) {
            start = new Date(Date.UTC(Y, M - 1, 1));
            /* day 0 of the next month is the last day of this one */
            end = new Date(Date.UTC(Y, M, 0, 23, 59, 59, 999));
            label = y + '-' + m;
            granularity = 'month';
        } else {
            start = new Date(Date.UTC(Y, 0, 1));
            end = new Date(Date.UTC(Y, 11, 31, 23, 59, 59, 999));
            label = y;
            granularity = 'year';
        }
        if (isNaN(start.getTime()) || isNaN(end.getTime())) { return null; }
        return { start: start, end: end, label: label, granularity: granularity };
    }

    function clzPairOf(prefix) {
        var s = segmentsOf(prefix);
        return (s.length >= 3) ? s[1] + '/' + s[2] : null;
    }

    /* ---------------------------------------------------------------- *
     * What already exists (section 18.4)
     * ---------------------------------------------------------------- */

    /** Ours by function (feeds the pipeline) vs ours by claim (we made it). */
    function isLogServInput(rec) { return rec.sourcetype === SOURCETYPE; }
    function isOurName(rec) { return String(rec.name || '').indexOf(NAME_PREFIX) === 0; }

    /**
     * exact     folder -> day -> the input that covers it (section-18 inputs,
     *           enabled OR disabled - a disabled one ran)
     * uncertain inputs made any other way that could hold a folder: they bound
     *           by write time, so which days they read cannot be known
     */
    function coverage(inputs) {
        var exact = {};
        var uncertain = [];
        (inputs || []).forEach(function (rec) {
            var c = parseCanonical(rec);
            if (c) {
                exact[c.folder] = exact[c.folder] || {};
                c.days.forEach(function (d) { exact[c.folder][d] = rec.name; });
                return;
            }
            if (!isLogServInput(rec) && !isOurName(rec)) { return; }
            var pair = clzPairOf(rec.key_name);
            if (!pair) { return; }
            uncertain.push({ name: rec.name, folder: pair, part: prefixDate(rec.key_name) });
        });
        return { exact: exact, uncertain: uncertain };
    }

    /** True when an input with this job's name already exists - in either the
     *  section-18 form or the older logserv_backfill_<suffix> form. */
    function jobInUse(job, names) {
        var whole = NAME_PREFIX + job;
        return (names || []).some(function (n) {
            return n === whole || String(n).indexOf(whole + '_') === 0;
        });
    }

    /* ---------------------------------------------------------------- *
     * The Data TA's own index-time filter (B7, reworked in section 18.5)
     * ---------------------------------------------------------------- */

    function patternHit(list, pair) {
        return String(list || '').split(',').some(function (p) {
            p = p.trim();
            if (!p) { return false; }
            if (p.slice(-1) === '*') { return pair.indexOf(p.slice(0, -1)) === 0; }
            return p === pair;
        });
    }

    /** Why this forwarder's include/exclude filter drops a folder, or ''. */
    function folderDropReason(folder, f) {
        if (!f || f.filter_enabled !== '1') { return ''; }
        var inc = String(f.include_filters || '*').trim();
        if (inc && inc !== '*' && !patternHit(inc, folder)) {
            return 'this forwarder’s include filter does not cover it';
        }
        if (String(f.exclude_filters || '').trim() && patternHit(f.exclude_filters, folder)) {
            return 'this forwarder’s exclude filter drops it';
        }
        return '';
    }

    /** The epoch ms before which days_in_past drops an event, or null. It
     *  compares the event's envelope _time against midnight UTC N days ago. */
    function cutoffMs(f, nowMs) {
        if (!f || f.filter_enabled !== '1') { return null; }
        var days = parseInt(f.days_in_past, 10);
        if (!(days > 0)) { return null; }
        return (nowMs - (nowMs % DAY_MS)) - days * DAY_MS;
    }

    /* ---------------------------------------------------------------- *
     * The plan (section 18.3) and the gate
     * ---------------------------------------------------------------- */

    /**
     * Turn the form into the inputs to create. Returns
     *   { errors, warnings, inputs, folders, days }
     * where every input is { name, folder, year, days, key_name, whitelist }.
     * Nothing here writes; the same plan feeds the live gate, the preview,
     * Mode 2's artifacts and the create.
     */
    function buildPlan(form, env) {
        var errors = [];
        var warnings = [];
        var plan = { errors: errors, warnings: warnings, inputs: [], folders: [], days: [] };

        var rows = (form.rows || []).filter(function (k) { return !!rowByKey(k); });
        if (!rows.length) { errors.push('Choose at least one dashboard.'); }

        var fromMs = parseUtcDate(form.scan_from);
        var untilMs = parseUtcDate(form.scan_until);
        var todayMs = parseUtcDate(todayUtc());
        if (fromMs === null) {
            errors.push('Scan from must be a real date, written YYYY-MM-DD.');
        } else if (fromMs < parseUtcDate(DATE_FLOOR)) {
            errors.push('Scan from must be ' + DATE_FLOOR + ' or later.');
        }
        if (untilMs === null) {
            errors.push('Scan until must be a real date, written YYYY-MM-DD.');
        } else if (untilMs > todayMs) {
            errors.push('Scan until cannot be later than today (' + todayUtc() + ' UTC).');
        }
        if (fromMs !== null && untilMs !== null) {
            if (untilMs < fromMs) {
                errors.push('Scan until must be the same day as Scan from or later.');
            } else if ((untilMs - fromMs) / DAY_MS + 1 > MAX_SPAN_DAYS) {
                errors.push('The range covers ' + ((untilMs - fromMs) / DAY_MS + 1) + ' days; the ' +
                    'limit is ' + MAX_SPAN_DAYS + '. Split a longer backfill into several.');
            }
        }
        if (errors.length) { return plan; }

        var folders = foldersFor(rows);
        var days = enumerateDays(fromMs, untilMs);
        plan.folders = folders;
        plan.days = days;

        var cov = coverage(env.inputs);
        var cutoff = cutoffMs(env.filterSettings, Date.now());
        var dropped = [];
        var coveredNotes = [];
        var cutoffDays = 0;

        folders.forEach(function (folder) {
            var why = folderDropReason(folder, env.filterSettings);
            if (why) { dropped.push(folder + ' (' + why + ')'); return; }

            var keep = [];
            var coveredBy = {};
            var coveredCount = 0;
            var behind = 0;
            days.forEach(function (d) {
                var t = parseUtcDate(d);
                /* Behind the cutoff when the day's LAST instant is. The cutoff is
                 * a UTC midnight, so a day is wholly on one side of it. */
                if (cutoff !== null && t + DAY_MS <= cutoff) { behind++; return; }
                var by = cov.exact[folder] && cov.exact[folder][d];
                if (by) { coveredCount++; coveredBy[by] = true; return; }
                keep.push(d);
            });
            cutoffDays = Math.max(cutoffDays, behind);
            if (coveredCount) {
                coveredNotes.push(folder + ': ' + coveredCount + ' day(s) already covered by ' +
                    Object.keys(coveredBy).sort().join(', ') + ' — skipped.');
            }

            cov.uncertain.forEach(function (u) {
                if (u.folder !== folder) { return; }
                var hits = keep.filter(function (d) {
                    var t = parseUtcDate(d);
                    return !u.part || (t >= u.part.start.getTime() && t <= u.part.end.getTime());
                });
                if (hits.length) {
                    warnings.push(u.name + ' was not made by this form and may already hold ' +
                        folder + (u.part ? ' for ' + u.part.label : '') + '. It selects by the ' +
                        'time objects were written, so this screen cannot tell which days it read. ' +
                        'Those ' + hits.length + ' day(s) are NOT skipped.');
                }
            });

            var byYear = {};
            var years = [];
            keep.forEach(function (d) {
                var y = d.slice(0, 4);
                if (!byYear[y]) { byYear[y] = []; years.push(y); }
                byYear[y].push(d);
            });
            years.forEach(function (y) {
                var yd = byYear[y];
                plan.inputs.push({
                    name: inputName(form.suffix, folder, y),
                    folder: folder,
                    year: y,
                    days: yd,
                    key_name: keyPrefixFor(folder, yd),
                    whitelist: buildWhitelist(folder, yd)
                });
            });
        });

        if (dropped.length) {
            warnings.push('Left out, because their events would be dropped at index time: ' +
                dropped.join('; ') + '. Change the Configuration → Filters tab to include them.');
        }
        if (cutoffDays) {
            warnings.push(cutoffDays + ' of the ' + days.length + ' day(s) are left out: they are ' +
                'older than this forwarder’s days_in_past = ' + env.filterSettings.days_in_past +
                ' cutoff (' + utcDateString(cutoff) + ' UTC), so every event in them would be ' +
                'dropped to nullQueue at index time. Raise days_in_past on the Configuration → ' +
                'Filters tab first to include them.');
        }
        Array.prototype.push.apply(warnings, coveredNotes);

        var recent = todayMs - SQS_RECENT_DAYS * DAY_MS;
        if (plan.inputs.some(function (it) {
            return it.days.some(function (d) { return parseUtcDate(d) >= recent; });
        })) {
            var names = (env.sqsInputs || []).map(function (e) { return e.name; });
            warnings.push('Scan until reaches today or one of the two days before it (UTC), which ' +
                'the SQS-Based S3 input' + (names.length ? ' (' + names.join(', ') + ')' : '') +
                ' is probably still delivering. Objects it has already delivered will be ingested ' +
                'a SECOND time — the two inputs do not share state. Prefer days that are already ' +
                'closed.');
        }

        if (!plan.inputs.length) {
            errors.push('Nothing is left to backfill: every folder-day in this selection is ' +
                'dropped by this forwarder’s filters or already covered — see the notes below.');
        }
        return plan;
    }

    /**
     * What is wrong with a job name RE_JOB refuses: one message per rule it
     * breaks, so the screen names the actual problem. (Session 143: a
     * 35-character name met one message that listed every rule, and read as an
     * objection to underscores it did not contain.) RE_JOB stays the rule; this
     * only explains a refusal. The checks below fire together exactly when
     * RE_JOB refuses - the test suite proves it over random names - so the last
     * line is a guard, not a path.
     */
    function jobNameProblems(job) {
        if (!job) {
            return ['Enter a job name: lower-case letters, digits and hyphens, up to 24.'];
        }
        var out = [];
        if (job.length > 24) {
            out.push('Job name is ' + job.length + ' characters long; the limit is 24.');
        }
        if (/[A-Z]/.test(job)) {
            out.push('Job name has upper-case letters; use lower case.');
        }
        if (job.indexOf('_') !== -1) {
            out.push('Job name has an underscore; use a hyphen instead.');
        }
        var other = job.replace(/[A-Za-z0-9_-]/g, '');
        if (other) {
            /* Whole characters, not UTF-16 halves; a space would be invisible in quotes. */
            var named = [];
            (other.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || []).forEach(function (c) {
                var d = c === ' ' ? 'spaces' : '"' + c + '"';
                if (named.indexOf(d) === -1) { named.push(d); }
            });
            out.push('Job name can only use lower-case letters, digits and hyphens, not ' +
                named.join(' or ') + '.');
        }
        if (job.charAt(0) === '-') {
            out.push('Job name must start with a letter or digit.');
        }
        if (!out.length) {
            out.push('Job name must be lower-case letters, digits and hyphens, up to 24.');
        }
        return out;
    }

    /**
     * Hard blocks and warnings for the form. Returns { errors, warnings, plan }.
     * One predicate for the live gate AND the submit guard (splitIssues).
     */
    function validate(form, env) {
        var errors = [];
        var warnings = [];

        if (!RE_JOB.test(form.suffix || '')) {
            jobNameProblems(form.suffix || '').forEach(function (m) { errors.push(m); });
        } else if (jobInUse(form.suffix, (env.inputs || []).map(function (r) { return r.name; }))) {
            errors.push('A backfill named "' + form.suffix + '" already exists on this instance. ' +
                'Pick another job name.');
        }
        if (!RE_BUCKET.test(form.bucket_name || '')) {
            errors.push('Bucket name is not a valid S3 bucket name.');
        }
        if (!form.aws_account) { errors.push('An AWS account is required.'); }

        /* Without the role the input authenticates as the bare IAM user and
         * returns an AccessDenied that reads like a bucket problem (design 1.2). */
        if (!form.aws_iam_role) {
            errors.push('An IAM role is required. Without it the input authenticates as the ' +
                'bare IAM user, which usually has no S3 access.');
        }
        /* host_name is set by the add-on on create only and never refreshed,
         * so aws_s3_region is the only region control that counts (L3-13). */
        if (!form.aws_s3_region) { errors.push('An AWS region is required.'); }

        /* The vendor declares index required=True with validator=None, so an
         * empty value is refused by splunktaucclib with
         * "Required field is missing: index" - verified by invoking
         * RestField.validate directly on splunk-hf-01. Nothing is created and
         * no events move, but without this check the screen offers a Create
         * that can only ever 400. Reachable when the indexes probe fails,
         * since every probe is .catch(() => null) and newForm then falls
         * through to ''. */
        if (!form.index) { errors.push('An index is required.'); }

        var plan = buildPlan(form, env);
        Array.prototype.push.apply(errors, plan.errors);
        Array.prototype.push.apply(warnings, plan.warnings);
        return { errors: errors, warnings: warnings, plan: plan };
    }

    /** Applied to records reconstructed from the add-on. A record failing this
     *  is shown read-only rather than blocking anything, because our patterns
     *  are deliberately stricter than the vendor's and would otherwise lock an
     *  operator out of a record the looser validator allowed (L3-11, L2-07). */
    function recordIssues(rec) {
        var out = [];
        if (!RE_FULL_NAME.test(rec.name || '')) {
            out.push('name is not safe to address through this screen');
        }
        if (rec.bucket_name && !RE_BUCKET.test(rec.bucket_name)) {
            out.push('bucket name is outside this screen’s pattern');
        }
        if (rec.key_name && !RE_KEY_NAME.test(rec.key_name)) {
            out.push('key prefix is outside this screen’s pattern');
        }
        return out;
    }

    /* ---------------------------------------------------------------- *
     * Environment probe and tier gating
     * ---------------------------------------------------------------- */

    function probe() {
        var env = {
            capabilities: [], mode: 'assisted',
            awsTa: null, awsTaPresent: false, awsTaDisabled: false, awsTaVersion: null,
            isCloud: false, isDS: false, guid: '',
            accounts: [], roles: [], indexes: [], inputs: [], sqsInputs: [],
            filterSettings: null, dsManagedAwsTa: null, probeFailed: false
        };

        return Promise.all([
            req(CURRENT_CONTEXT).catch(function () { return null; }),
            req(APPS_LOCAL + '?search=' + enc('name=Splunk_TA_aws')).catch(function () { return null; }),
            req(SERVER_INFO).catch(function () { return null; }),
            req(DEPLOY_PUSH).catch(function () { return null; }),
            req(DEPLOY_CLIENT).catch(function () { return null; }),
            req(FILTER_SETTINGS).catch(function () { return null; })
        ]).then(function (r) {
            var ctx = r[0], apps = r[1], info = r[2], push = r[3], dc = r[4], fs = r[5];

            /* Fail safe: any failure to establish capability selects Assisted
             * mode. A button that then 403s is worse than a correct command. */
            if (ctx && ctx.ok) {
                var c = entries(ctx)[0];
                env.capabilities = (c && c.content && c.content.capabilities) || [];
            } else {
                env.probeFailed = true;
            }
            env.mode = env.capabilities.indexOf('admin_all_objects') !== -1 ? 'managed' : 'assisted';

            var appEntry = entries(apps)[0];
            if (appEntry) {
                env.awsTa = appEntry;
                env.awsTaVersion = (appEntry.content && appEntry.content.version) || null;
                /* /services/apps/local lists DISABLED apps too, so presence
                 * alone is not enough (L1-03). */
                env.awsTaDisabled = !!(appEntry.content && appEntry.content.disabled);
                env.awsTaPresent = !env.awsTaDisabled;
            }

            if (info && info.ok) {
                var ic = entries(info)[0];
                var content = (ic && ic.content) || {};
                env.isCloud = String(content.instance_type || '').toLowerCase().indexOf('cloud') !== -1;
                env.guid = content.guid || '';
            }

            /* Reuse the Data TA's shipped detector rather than re-parsing
             * server_roles: it has a phone-home fallback that role parsing
             * alone misses (L1-11). */
            if (push && push.ok) {
                var pe = entries(push)[0];
                var pc = (pe && pe.content) || {};
                env.isDS = pc.is_deployment_server === true || pc.is_deployment_server === '1';
            }

            /* If Splunk_TA_aws is itself DS-managed, every input created here
             * is destroyed on the next deployment push and this screen's list
             * is the only record (B2). Best effort: unknown on probe failure,
             * and we make no claim in that case. */
            if (dc && dc.ok) {
                env.dsManagedAwsTa = JSON.stringify(dc.json || {}).indexOf('Splunk_TA_aws') !== -1;
            }

            if (fs && fs.ok) {
                var fe = entries(fs)[0];
                env.filterSettings = (fe && fe.content) || null;
            }

            if (!env.awsTaPresent) { return env; }

            return Promise.all([
                req(ACCOUNTS_EP + '?count=0').catch(function () { return null; }),
                req(ROLES_EP + '?count=0').catch(function () { return null; }),
                req(INDEXES_EP + '?count=0&search=' + enc('disabled=0')).catch(function () { return null; }),
                req(S3_EP + '?count=0').catch(function () { return null; }),
                req(SQS_EP + '?count=0').catch(function () { return null; })
            ]).then(function (rr) {
                env.accounts = entries(rr[0]).map(function (e) {
                    return { name: e.name, account_id: (e.content || {}).account_id || '' };
                });
                env.roles = entries(rr[1]).map(function (e) { return { name: e.name }; });
                env.indexes = entries(rr[2]).map(function (e) { return e.name; })
                    .filter(function (n) { return n.charAt(0) !== '_'; });
                env.inputs = entries(rr[3]).map(toRecord);
                env.sqsInputs = entries(rr[4]).map(function (e) { return { name: e.name }; });
                env.hasEnabledAwsInput =
                    entries(rr[3]).concat(entries(rr[4])).some(function (e) {
                        return e.content && e.content.disabled === false;
                    });
                return env;
            });
        });
    }

    function toRecord(e) {
        var c = e.content || {};
        return {
            name: e.name,
            aws_account: c.aws_account || '',
            aws_iam_role: c.aws_iam_role || '',
            aws_s3_region: c.aws_s3_region || '',
            bucket_name: c.bucket_name || '',
            key_name: c.key_name || '',
            whitelist: c.whitelist || '',
            initial_scan_datetime: c.initial_scan_datetime || '',
            terminal_scan_datetime: c.terminal_scan_datetime || '',
            polling_interval: c.polling_interval || '',
            index: c.index || '',
            sourcetype: c.sourcetype || '',
            disabled: c.disabled === true || c.disabled === '1',
            raw: c
        };
    }

    /* ---------------------------------------------------------------- *
     * Payload builders
     *
     * There is no update builder any more (section 18.1): a backfill is
     * created and deleted, never edited. name is sent only here, and
     * re-listing before a create guards the one case where sending it is
     * dangerous - an existing name, whose checkpoint the add-on's create
     * hook would reset (17a.2).
     * ---------------------------------------------------------------- */

    function commonFields(form) {
        return {
            aws_account: form.aws_account,
            aws_iam_role: form.aws_iam_role,
            aws_s3_region: form.aws_s3_region,
            bucket_name: form.bucket_name,
            polling_interval: POLL_SECONDS,
            index: form.index,
            sourcetype: SOURCETYPE,
            /* Rejected without it on EVERY call, not just create. */
            parse_csv_with_delimiter: ',',
            parse_csv_with_header: '0',
            max_items: MAX_ITEMS,
            recursion_depth: '-1',
            character_set: 'auto',
            is_secure: '1'
        };
    }

    /** The write-time upper bound: the moment of creation, whole seconds,
     *  plus the section-18.2 margin. */
    function terminalFor(nowMs) {
        return isoZ(new Date(nowMs - (nowMs % 1000) + TERMINAL_MARGIN_MS));
    }

    function buildCreate(form, item, nowMs) {
        var p = commonFields(form);
        p.name = item.name;
        p.key_name = item.key_name;
        p.whitelist = item.whitelist;
        p.initial_scan_datetime = SCAN_FLOOR;
        p.terminal_scan_datetime = terminalFor(nowMs);
        return p;
    }

    /* ---------------------------------------------------------------- *
     * Mode 2 artifacts
     *
     * Built once, safely, and the SAME string is displayed and copied. Reading
     * the text back out of the DOM would decode the HTML escaping and hand the
     * administrator the raw payload (L2-05).
     * ---------------------------------------------------------------- */

    function buildStanza(form, item, nowMs) {
        var name = confStanzaName(item.name);
        var p = buildCreate(form, item, nowMs);
        var lines = ['[aws_s3://' + name + ']'];
        Object.keys(p).forEach(function (k) {
            if (k === 'name') { return; }
            lines.push(k + ' = ' + confValue(p[k]));
        });
        /* The UCC endpoint rejects _meta, so Mode 1 cannot stamp it while a
         * hand-written stanza can. Every SQS input on the fleet carries it and
         * cloud_provider is a rollup grain dimension, so omitting it would
         * attribute backfilled events differently from their neighbours
         * (L3-08). */
        lines.push('_meta = cloud_provider::aws');
        return lines.join('\n');
    }

    function buildStanzas(form, plan, nowMs) {
        return plan.inputs.map(function (it) { return buildStanza(form, it, nowMs); }).join('\n\n');
    }

    function buildCurl(form, item, nowMs) {
        var p = buildCreate(form, item, nowMs);
        var host = window.location.hostname;
        var out = [
            'curl -k -u ' + shq('<your-splunk-username>') + ' \\',
            '  ' + shq('https://' + host + ':8089/servicesNS/nobody/Splunk_TA_aws/data/inputs/aws_s3') + ' \\'
        ];
        var keys = Object.keys(p);
        keys.forEach(function (k, i) {
            out.push('  --data-urlencode ' + shq(k + '=' + p[k]) + (i === keys.length - 1 ? '' : ' \\'));
        });
        return out.join('\n');
    }

    function buildCurls(form, plan, nowMs) {
        var host = window.location.hostname;
        var out = [
            '# Run as a Splunk administrator on ' + host + '.',
            '# curl prompts for the password once per input; do not type it on the command line.',
            '# The stanza block above is the quicker way to apply a long list.'
        ];
        plan.inputs.forEach(function (it) {
            out.push('');
            out.push(buildCurl(form, it, nowMs));
        });
        return out.join('\n');
    }

    /* ---------------------------------------------------------------- *
     * Rendering
     * ---------------------------------------------------------------- */

    var root, state = { env: null, form: null, flash: null };

    function banner(kind, title, lines) {
        var box = el('div', { cls: 'logserv-s3-banner logserv-s3-' + kind });
        box.appendChild(el('strong', { text: title }));
        (lines || []).forEach(function (t) { box.appendChild(el('p', { text: t })); });
        return box;
    }

    function copyable(label, content) {
        var wrap = el('div', { cls: 'logserv-s3-artifact' });
        var head = el('div', { cls: 'logserv-s3-artifact-head' }, [el('strong', { text: label })]);
        head.appendChild(el('button', {
            type: 'button', cls: 'btn', text: 'Copy',
            onclick: function () { copyText(content, head); }
        }));
        wrap.appendChild(head);
        wrap.appendChild(el('pre', { text: content }));
        return wrap;
    }

    /** navigator.clipboard is secure-context only and Splunk Web is commonly
     *  served over HTTP here, so the execCommand path is the live one (L2-05). */
    function copyText(text, host) {
        function done(ok) {
            var n = el('span', { cls: 'logserv-s3-copied', text: ok ? ' copied' : ' copy failed' });
            host.appendChild(n);
            setTimeout(function () { if (n.parentNode) { n.parentNode.removeChild(n); } }, 2000);
        }
        if (window.navigator && navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(function () { done(true); },
                function () { done(false); });
            return;
        }
        var ta = el('textarea', { cls: 'logserv-s3-clip' });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        done(ok);
    }

    function rowLabels(rowKeys) {
        return (rowKeys || []).map(function (k) {
            var r = rowByKey(k);
            return r ? r.label : null;
        }).filter(function (x) { return x; });
    }

    /** The per-input table shared by the live plan and Mode 2 (L2-08: an
     *  administrator is shown the parameters, not just a blob). */
    function planTable(plan) {
        var tbl = el('table', { cls: 'logserv-s3-table logserv-s3-plan' });
        tbl.appendChild(el('tr', null, ['Input', 'Key prefix', 'Days'].map(function (h) {
            return el('th', { text: h });
        })));
        plan.inputs.forEach(function (it) {
            tbl.appendChild(el('tr', null, [
                el('td', { text: it.name }),
                el('td', { text: it.key_name }),
                el('td', {
                    text: it.days.length === 1 ? it.days[0]
                        : it.days[0] + ' → ' + it.days[it.days.length - 1] + ' (' + it.days.length + ')'
                })
            ]));
        });
        return tbl;
    }

    function paramTable(form, plan, nowMs) {
        var rows = [
            ['Bucket', form.bucket_name], ['Index', form.index], ['Sourcetype', SOURCETYPE],
            ['AWS account', form.aws_account], ['IAM role', form.aws_iam_role],
            ['Region', form.aws_s3_region],
            ['Dashboards', rowLabels(form.rows).join('; ')],
            ['Days (UTC, key dates)', form.scan_from + ' → ' + form.scan_until],
            ['Inputs', String(plan.inputs.length) + ' — one per S3 folder and year'],
            ['Write-time window', SCAN_FLOOR + ' → ' + terminalFor(nowMs) +
                ' (every write time; the inputs stop by themselves at the end)']
        ];
        var tbl = el('table', { cls: 'logserv-s3-params' });
        rows.forEach(function (r) {
            tbl.appendChild(el('tr', null, [
                el('th', { text: r[0] }), el('td', { text: r[1] || '' })
            ]));
        });
        return tbl;
    }

    function newForm(env) {
        /* A week that SQS has finished delivering: today and the two UTC days
         * before it are left out by default (L3-09). */
        var t = parseUtcDate(todayUtc());
        return {
            suffix: '', aws_account: (env.accounts[0] || {}).name || '',
            aws_iam_role: (env.roles[0] || {}).name || '', aws_s3_region: '',
            bucket_name: '', rows: [],
            scan_from: utcDateString(t - 9 * DAY_MS),
            scan_until: utcDateString(t - 3 * DAY_MS),
            index: env.indexes.indexOf(SOURCETYPE) !== -1 ? SOURCETYPE : (env.indexes[0] || '')
        };
    }

    /** True when this browser implements <input type="date">. One that does
     *  not reports type === 'text' after setAttribute; it then gets a text box
     *  with the format as its placeholder, and the same validation. */
    function supportsDateInput() {
        try {
            var probeEl = document.createElement('input');
            probeEl.setAttribute('type', 'date');
            return probeEl.type === 'date';
        } catch (e) {
            return false;
        }
    }

    function field(label, key, opts) {
        opts = opts || {};
        var id = 'lsf-' + key;
        var wrap = el('div', { cls: 'logserv-s3-field' });
        wrap.appendChild(el('label', { for: id, text: label }));
        var input;
        if (opts.choices) {
            input = el('select', { id: id });
            /* A stored value this instance no longer offers must still be the
             * one on display. With no matching <option> the browser selects the
             * FIRST, while state.form keeps - and the write sends - the stored
             * value, so the control shows one account and saves another.
             *
             * Carrying the stored value as its own option keeps display equal
             * to payload. The VALUE stays exact, so reading it back is
             * unaffected; only the label says why it is there. Empty is
             * included: validate() hard-blocks an empty account, role and
             * index, so the empty state is visible AND refused. */
            var cur = state.form[key];
            var curStr = (cur === undefined || cur === null) ? '' : String(cur);
            var offered = (opts.choices || []).some(function (c) {
                return String(c) === curStr;
            });
            if (!offered) {
                /* Say only what we actually know. "Not available on this
                 * instance" would be a claim about the INSTANCE drawn from
                 * evidence that only describes OUR LIST, and it is false in the
                 * cases most likely to produce it: an internal index is hidden
                 * by our own charAt(0) !== '_' filter, a disabled index by the
                 * probe's disabled=0 search, and a failed probe is
                 * indistinguishable from an empty one because every probe is
                 * .catch(() => null). */
                var listUnread = !(opts.choices || []).length;
                var stale = el('option', {
                    value: curStr,
                    text: curStr === ''
                        ? '(not set)'
                        : curStr + (listUnread
                            ? ' - stored value; this list could not be read'
                            : ' - stored value, not in this list')
                });
                stale.setAttribute('selected', 'selected');
                input.appendChild(stale);
            }
            (opts.choices || []).forEach(function (c) {
                var o = el('option', { value: c, text: c });
                if (curStr === String(c)) { o.setAttribute('selected', 'selected'); }
                input.appendChild(o);
            });
        } else if (opts.date && supportsDateInput()) {
            input = el('input', { id: id, type: 'date', min: DATE_FLOOR, max: todayUtc() });
            input.value = state.form[key] === undefined ? '' : state.form[key];
        } else {
            input = el('input', { id: id, type: 'text' });
            if (opts.date) { input.setAttribute('placeholder', 'YYYY-MM-DD'); }
            input.value = state.form[key] === undefined ? '' : state.form[key];
        }
        /* A date control's value is already 'YYYY-MM-DD' (or '' when it holds
         * nothing it can represent), which is the form's own format - so every
         * control reads back verbatim and validate() decides. */
        function readBack() { state.form[key] = input.value; }
        input.addEventListener('change', readBack);
        input.addEventListener('input', readBack);
        wrap.appendChild(input);
        if (opts.help) { wrap.appendChild(el('p', { cls: 'logserv-s3-help', text: opts.help })); }
        return wrap;
    }

    /** The 25 rows as checkboxes. Each change updates state.form.rows at the
     *  target, then bubbles to the section's delegated live gate. */
    function rowsField() {
        var wrap = el('div', { cls: 'logserv-s3-field' });
        /* A group title, not a <label>: a label names ONE control, and tying
         * this one to the first checkbox would announce "Dashboards" as that
         * row's name. The group is named through aria-label instead. */
        wrap.appendChild(el('div', { cls: 'logserv-s3-group-title', text: 'Dashboards' }));
        var list = el('div', { cls: 'logserv-s3-rowlist', role: 'group', 'aria-label': 'Dashboards' });
        ROLLUP_FOLDERS.forEach(function (r) {
            var id = 'lsf-row-' + r.key;
            var cb = el('input', { id: id, type: 'checkbox', value: r.key });
            cb.checked = (state.form.rows || []).indexOf(r.key) !== -1;
            cb.addEventListener('change', function () {
                var cur = (state.form.rows || []).filter(function (k) { return k !== r.key; });
                if (cb.checked) { cur.push(r.key); }
                state.form.rows = cur;
            });
            list.appendChild(el('label', { cls: 'logserv-s3-row', for: id }, [
                cb, ' ' + r.label + ' ',
                el('span', {
                    cls: 'logserv-s3-count',
                    text: '(' + r.folders.length + (r.folders.length === 1 ? ' folder)' : ' folders)')
                })
            ]));
        });
        wrap.appendChild(list);
        wrap.appendChild(el('p', {
            cls: 'logserv-s3-help',
            text: 'The same rows as the App’s Settings → Dashboard Data. The screen reads every S3 ' +
                'folder a chosen row is built from; a folder two rows share is read once.'
        }));
        return wrap;
    }

    /**
     * Split a validation result into what BLOCKS and what merely warns.
     *
     * The render-time gate and the submit-time guard both go through here, so
     * they cannot disagree about what "blocked" means. That matters: if the
     * guard were looser than the gate it would admit a write the UI had
     * already refused to offer, and if it were stricter it would lock an
     * operator out of a create the gate had been happy to show.
     */
    function splitIssues(res) {
        return {
            soft: res.warnings.filter(function (w) { return w.indexOf('BLOCKING:') !== 0; }),
            hard: res.errors.concat(res.warnings
                .filter(function (w) { return w.indexOf('BLOCKING:') === 0; })
                .map(function (w) { return w.replace('BLOCKING: ', ''); }))
        };
    }

    function renderPlan(plan) {
        var box = el('div', { cls: 'logserv-s3-plan-box' });
        if (!plan.inputs.length) { return box; }
        box.appendChild(el('h4', {
            text: 'Plan: ' + plan.inputs.length + ' input(s) — ' + plan.folders.length +
                ' S3 folder(s), ' + plan.days.length + ' day(s) from ' + plan.days[0] + ' to ' +
                plan.days[plan.days.length - 1] + ' (UTC)'
        }));
        box.appendChild(planTable(plan));
        return box;
    }

    function renderEditor(container, env) {
        var section = el('div', { cls: 'logserv-s3-section' });
        section.appendChild(el('h3', { text: 'Create a backfill' }));
        section.appendChild(el('p', {
            cls: 'logserv-s3-note',
            text: 'Choose the dashboards to backfill and a range of UTC days. The screen builds one ' +
                'input per S3 folder and year, each reading only the chosen days, and each stops ' +
                'by itself a day after it is created. A backfill cannot be edited: to change one, ' +
                'delete it and create another.'
        }));

        section.appendChild(field('Job name', 'suffix', {
            help: 'Names this backfill. Lower-case letters, digits and hyphens, up to 24.'
        }));
        section.appendChild(field('AWS account', 'aws_account',
            { choices: env.accounts.map(function (a) { return a.name; }) }));
        section.appendChild(field('IAM role', 'aws_iam_role',
            {
                choices: env.roles.map(function (r) { return r.name; }),
                help: 'Required. Without it the input authenticates as the bare IAM user and ' +
                    'returns an AccessDenied that looks like a bucket problem.'
            }));
        section.appendChild(field('AWS region', 'aws_s3_region', {
            help: 'Required. The add-on records the bucket endpoint when an input is created ' +
                'and never refreshes it, so this is the region control that counts.'
        }));
        section.appendChild(field('Bucket', 'bucket_name', {
            help: 'The bucket NAME on its own — not an ARN and not a URL. ' +
                'For example splunk-logserv-remote-bucket-perm, not ' +
                'arn:aws:s3:::splunk-logserv-remote-bucket-perm, not ' +
                's3://splunk-logserv-remote-bucket-perm and not an https:// endpoint. ' +
                'The region is set separately above.'
        }));
        section.appendChild(rowsField());
        section.appendChild(field('Scan from (UTC date)', 'scan_from', {
            date: true,
            help: 'The first day to read. It selects the date in the S3 key — ' +
                'logserv/<clz_dir>/<clz_subdir>/YYYY/MM/DD/ — which is the date of the events, ' +
                'not the time SAP wrote the object. Read as a UTC date.'
        }));
        section.appendChild(field('Scan until (UTC date)', 'scan_until', {
            date: true,
            help: 'The last day to read, inclusive, as a UTC date: no later than today, and at ' +
                'most ' + MAX_SPAN_DAYS + ' days counting Scan from. Today and the two days ' +
                'before it are probably still being delivered by the SQS-Based S3 input.'
        }));
        section.appendChild(field('Index', 'index', { choices: env.indexes }));

        /*
         * The gate has to be LIVE, not drawn once (17c, B9): nothing re-renders
         * when a field changes, so a gate drawn at render time never offers the
         * button a correctly completed form has earned. Repainting just these
         * boxes - never the inputs - keeps the caret and an open date popup
         * untouched.
         */
        var gateBox = el('div');
        var planBox = el('div');
        var bar = el('div', { cls: 'logserv-s3-actions' });
        var assistedBox = el('div');
        section.appendChild(gateBox);
        section.appendChild(planBox);
        section.appendChild(bar);
        section.appendChild(assistedBox);

        function refreshGates() {
            clear(gateBox); clear(planBox); clear(bar); clear(assistedBox);
            var res = validate(state.form, env);
            var iss = splitIssues(res);
            iss.hard.forEach(function (e) {
                gateBox.appendChild(banner('error', 'Cannot continue', [e]));
            });
            iss.soft.forEach(function (w) {
                gateBox.appendChild(banner('warn', 'Check this', [w]));
            });
            if (!iss.hard.length) { planBox.appendChild(renderPlan(res.plan)); }
            if (env.mode === 'managed' && !iss.hard.length) {
                bar.appendChild(el('button', {
                    type: 'button', cls: 'btn btn-primary',
                    text: 'Create backfill (' + res.plan.inputs.length + ' input' +
                        (res.plan.inputs.length === 1 ? '' : 's') + ')',
                    onclick: function () { submitCreate(); }
                }));
            }
            if (env.mode === 'assisted') {
                assistedBox.appendChild(renderAssisted(env, res.plan, iss.hard.length > 0));
            }
        }

        /* Delegated, and on the BUBBLE phase: each control's own handler runs at
         * the target first, so state.form is already current by the time this
         * sees the event. Capture phase would read the value the operator had
         * just replaced. Delegation also covers the checkboxes and the <select>
         * fields for free. */
        section.addEventListener('input', refreshGates);
        section.addEventListener('change', refreshGates);
        refreshGates();

        container.appendChild(section);
    }

    function renderAssisted(env, plan, blocked) {
        var box = el('div', { cls: 'logserv-s3-section logserv-s3-assisted' });
        box.appendChild(el('h3', { text: 'Apply this as an administrator' }));
        box.appendChild(el('p', {
            text: 'Your account lacks the admin_all_objects capability that Splunk requires to ' +
                'create an input, so this screen generates the exact configuration instead: one ' +
                'input per S3 folder and year. An administrator must review the parameters below ' +
                'and apply it.'
        }));
        if (blocked) {
            box.appendChild(banner('error', 'Nothing generated',
                ['Resolve the errors above first — this screen will not generate a command ' +
                 'from values it cannot validate.']));
            return box;
        }
        var nowMs = Date.now();
        box.appendChild(paramTable(state.form, plan, nowMs));
        box.appendChild(planTable(plan));
        box.appendChild(el('p', {
            cls: 'logserv-s3-note',
            text: 'Administrator: confirm the bucket, the dashboards and the days with whoever ' +
                'asked for this before applying it. These inputs stop by themselves at ' +
                terminalFor(nowMs) + ' UTC; if you apply them after that, generate them again.'
        }));
        try {
            box.appendChild(copyable('inputs.conf stanzas (Splunk_TA_aws/local/inputs.conf)',
                buildStanzas(state.form, plan, nowMs)));
            box.appendChild(copyable('REST calls', buildCurls(state.form, plan, nowMs)));
            /* Not "equivalent": the native endpoint refuses _meta (HTTP 400,
             * measured on hf-01, session 136), so these calls cannot stamp. */
            box.appendChild(el('p', {
                cls: 'logserv-s3-note',
                text: 'The REST calls cannot set _meta - the add-on refuses it - so inputs made with ' +
                    'them do not carry cloud_provider=aws. Add "_meta = cloud_provider::aws" to each ' +
                    'stanza afterwards and disable and enable the input, or apply the stanzas instead.'
            }));
        } catch (e) {
            box.appendChild(banner('error', 'Cannot generate a safe artifact', [String(e.message || e)]));
        }
        return box;
    }

    /** Group the LogServ inputs: section-18 backfills by job, everything else
     *  on its own. */
    function groupInputs(inputs) {
        var jobs = {};
        var order = [];
        var singles = [];
        (inputs || []).forEach(function (rec) {
            if (!isLogServInput(rec) && !isOurName(rec)) { return; }
            var c = parseCanonical(rec);
            if (c) {
                if (!jobs[c.job]) { jobs[c.job] = []; order.push(c.job); }
                jobs[c.job].push({ rec: rec, c: c });
            } else {
                singles.push(rec);
            }
        });
        order.sort();
        return { jobs: jobs, order: order, singles: singles };
    }

    /** The scan check for the inputs whose names match `pattern` (section 18.11).
     *  Grouped by a level that is never null: stats ... by drops every event
     *  whose group-by field is null, and Splunk_TA_aws 8.1.0 logs level=, not
     *  log_level=, so grouping by log_level returned nothing for a backfill that
     *  had run (session 137). level, else log_level, else "(none)" - a line in
     *  any other format still counts. */
    function scanCheck(pattern) {
        return 'index=_internal source=*splunk_ta_aws* datainput="' + pattern + '" ' +
            '| eval level=coalesce(level, log_level, "(none)") | stats count by datainput, level';
    }

    function renderList(container, env) {
        var section = el('div', { cls: 'logserv-s3-section' });
        section.appendChild(el('h3', { text: 'LogServ S3 inputs on this instance' }));

        var g = groupInputs(env.inputs);
        if (!g.order.length && !g.singles.length) {
            section.appendChild(el('p', {
                text: 'No LogServ-scoped Generic S3 inputs are configured here.'
            }));
            container.appendChild(section);
            return;
        }

        if (g.order.length) {
            section.appendChild(el('h4', { text: 'Backfills' }));
            var jt = el('table', { cls: 'logserv-s3-table' });
            jt.appendChild(el('tr', null,
                ['Backfill', 'S3 folders', 'Days (UTC)', 'Inputs enabled', 'Stops by itself (UTC)', '']
                    .map(function (h) { return el('th', { text: h }); })));
            g.order.forEach(function (job) {
                var members = g.jobs[job];
                var folders = {};
                var days = {};
                members.forEach(function (m) {
                    folders[m.c.folder] = true;
                    m.c.days.forEach(function (d) { days[d] = true; });
                });
                var dayList = Object.keys(days).sort();
                var enabled = members.filter(function (m) { return !m.rec.disabled; }).length;
                var stops = members.map(function (m) { return m.rec.terminal_scan_datetime; })
                    .filter(function (x) { return x; }).sort()[0] || '';
                var actions = el('td');
                if (env.mode === 'managed') {
                    if (enabled < members.length) {
                        actions.appendChild(el('button', {
                            type: 'button', cls: 'btn', text: 'Enable all',
                            onclick: function () { toggleJob(job, members, 'enable'); }
                        }));
                    }
                    if (enabled > 0) {
                        actions.appendChild(el('button', {
                            type: 'button', cls: 'btn', text: 'Disable all',
                            onclick: function () { toggleJob(job, members, 'disable'); }
                        }));
                    }
                    actions.appendChild(el('button', {
                        type: 'button', cls: 'btn btn-danger', text: 'Delete all',
                        onclick: function () { deleteJob(job, members); }
                    }));
                } else {
                    actions.appendChild(el('span', { cls: 'logserv-s3-note', text: 'read-only' }));
                }
                jt.appendChild(el('tr', null, [
                    el('td', { text: job }),
                    el('td', { text: String(Object.keys(folders).length) }),
                    el('td', {
                        text: dayList[0] + ' → ' + dayList[dayList.length - 1] +
                            ' (' + dayList.length + ' day' + (dayList.length === 1 ? '' : 's') + ')'
                    }),
                    el('td', { text: enabled + ' of ' + members.length }),
                    el('td', { text: stops }),
                    actions
                ]));
                var detail = el('ul', { cls: 'logserv-s3-members' });
                members.forEach(function (m) {
                    detail.appendChild(el('li', {
                        text: m.rec.name + ' — ' + m.rec.key_name + ' — ' + m.c.days.length +
                            ' day(s)' + (m.rec.disabled ? ' — disabled' : '')
                    }));
                });
                /* The verify searches belong to the backfill, not to the form:
                 * the form resets after a create and is gone after a reload, and
                 * people come back later to check (section 18.11). Epoch bounds,
                 * not @d or span=1d - those follow the searching user's time
                 * zone, and these days are UTC. */
                var firstMs = parseUtcDate(dayList[0]);
                var lastMs = parseUtcDate(dayList[dayList.length - 1]);
                var jobIdx = members[0].rec.index || SOURCETYPE;
                jt.appendChild(el('tr', null, [el('td', { colspan: '6' }, [
                    detail,
                    copyable('Did its inputs finish their scan?', scanCheck(NAME_PREFIX + job + '_*')),
                    copyable('Did events reach the index for its days?',
                        '| tstats count where index=' + jobIdx + ' earliest=' + (firstMs / 1000) +
                        ' latest=' + ((lastMs + DAY_MS) / 1000) + ' by sourcetype')
                ])]));
            });
            section.appendChild(jt);
        }

        if (g.singles.length) {
            section.appendChild(el('h4', { text: g.order.length ? 'Other LogServ inputs' : 'LogServ inputs' }));
            var tbl = el('table', { cls: 'logserv-s3-table' });
            tbl.appendChild(el('tr', null, ['Name', 'Bucket', 'Key prefix', 'Scan until (UTC)', 'State', '']
                .map(function (h) { return el('th', { text: h }); })));
            g.singles.forEach(function (rec) {
                var issues = recordIssues(rec);
                var foreign = !isOurName(rec);
                var wrongRoute = isOurName(rec) && !isLogServInput(rec);
                var tr = el('tr', null, [
                    el('td', { text: rec.name }),
                    el('td', { text: rec.bucket_name }),
                    el('td', { text: rec.key_name }),
                    el('td', { text: rec.terminal_scan_datetime || '(unbounded)' }),
                    el('td', { text: rec.disabled ? 'disabled' : 'enabled' })
                ]);
                var actions = el('td');
                if (issues.length) {
                    /* Not addressable safely: no buttons, and say why (L2-02). */
                    actions.appendChild(el('span', {
                        cls: 'logserv-s3-note',
                        text: 'read-only — ' + issues.join('; ')
                    }));
                } else if (env.mode === 'managed') {
                    actions.appendChild(el('button', {
                        type: 'button', cls: 'btn',
                        text: rec.disabled ? 'Enable' : 'Disable',
                        onclick: function () { toggleInput(rec); }
                    }));
                    actions.appendChild(el('button', {
                        type: 'button', cls: 'btn btn-danger', text: 'Delete',
                        onclick: function () { confirmDelete(rec, foreign); }
                    }));
                } else {
                    actions.appendChild(el('span', { cls: 'logserv-s3-note', text: 'read-only' }));
                }
                tr.appendChild(actions);
                tbl.appendChild(tr);
                if (wrongRoute) {
                    tbl.appendChild(el('tr', null, [el('td', {
                        colspan: '6', cls: 'logserv-s3-warn',
                        text: 'Named like an input from this screen but its sourcetype is "' +
                            rec.sourcetype + '", so it is NOT routed through the Data TA pipeline.'
                    })]));
                }
            });
            section.appendChild(tbl);
            section.appendChild(el('p', {
                cls: 'logserv-s3-note',
                text: 'These inputs select objects by the time they were written, so this screen ' +
                    'cannot tell which days they read and does not skip those days in a new backfill.'
            }));
        }

        section.appendChild(el('p', {
            cls: 'logserv-s3-note',
            text: 'A backfill past its stop time may be finished, still fetching, or interrupted — ' +
                'the add-on keeps that state in a checkpoint file this screen cannot read. Verify ' +
                'with the two searches under each backfill before assuming it completed. A backfill\'s days are only ' +
                'skipped by later ones while its inputs exist: to stop one but keep that record, ' +
                'Disable it rather than Delete it.'
        }));
        container.appendChild(section);
    }

    /* ---------------------------------------------------------------- *
     * Writes
     * ---------------------------------------------------------------- */

    var inFlight = false;

    /** Run fn(item) for each item, strictly one after another, stopping at the
     *  first response that is not ok. Resolves { done: [...], failed: {item,
     *  resp} | null }. Never retries. */
    function sequential(items, fn) {
        var done = [];
        var failed = null;
        return items.reduce(function (p, item) {
            return p.then(function () {
                if (failed) { return; }
                return fn(item).then(function (r) {
                    if (r && r.ok) { done.push(item); } else { failed = { item: item, resp: r }; }
                });
            });
        }, Promise.resolve()).then(function () { return { done: done, failed: failed }; });
    }

    /**
     * Create the plan's inputs.
     *
     * Refuses a write the gate would not have offered (same predicate). Then
     * re-lists: creating over an existing name would fire the add-on's create
     * hook, which DELETES that input's checkpoint and re-ingests everything
     * (17a.2) - so a job name that has appeared since the page loaded stops
     * the create before anything is sent. The inputs are then created one at a
     * time; the first failure stops the run, and nothing is retried.
     */
    function submitCreate() {
        if (inFlight) { return; }
        var form = state.form;
        var res = validate(form, state.env);
        var hard = splitIssues(res).hard;
        if (hard.length) { return flash('error', 'Cannot create this backfill', hard); }
        var plan = res.plan;
        var labels = rowLabels(form.rows);

        inFlight = true;
        req(S3_EP + '?count=0').then(function (resp) {
            var names = entries(resp).map(function (e) { return e.name; });
            if (jobInUse(form.suffix, names)) {
                inFlight = false;
                return flash('error', 'A backfill named "' + form.suffix + '" already exists',
                    ['Creating over one of its inputs would reset that input\'s checkpoint and ' +
                     're-ingest everything it has read. Pick another job name.']);
            }
            var nowMs = Date.now();
            var unstamped = [];
            return sequential(plan.inputs, function (item) {
                var body = formEncode(buildCreate(form, item, nowMs));
                /* Never auto-retry a create (17a.2). */
                return req(S3_EP, { method: 'POST', body: body }, false).then(function (r) {
                    if (!r.ok) {
                        console.warn('LogServ S3 Direct: create failed', item.name, r.status, r.text);
                        return r;
                    }
                    return stampMeta(item.name).then(function (why) {
                        if (why) { unstamped.push(item.name + ' (' + why + ')'); }
                        return r;
                    });
                });
            }).then(function (out) {
                inFlight = false;
                var stop = terminalFor(nowMs);
                var next = 'Next, on the search head: open the Splunk App for SAP LogServ → ' +
                    'Settings → Dashboard Data, choose Custom range ' + form.scan_from + ' to ' +
                    form.scan_until + ' (UTC), and backfill ' +
                    (labels.length === 1 ? 'the row ' : 'these rows: ') + labels.join('; ') + '. ' +
                    'The dashboards read those rollups, and the hourly aggregates never revisit ' +
                    'old days, so the backfilled events will not appear there until then.';
                var metaNote = unstamped.length
                    ? ['Note: the cloud_provider stamp did not complete on ' + unstamped.length +
                       ' input(s): ' + unstamped.join(', ') + '. Their events may not carry ' +
                       'cloud_provider=aws. Add "_meta = cloud_provider::aws" to those stanzas by ' +
                       'hand if you need the Multi-Cloud dashboard to attribute them.']
                    : [];
                if (!out.failed) {
                    flash('ok', 'Created backfill ' + form.suffix + ' — ' + out.done.length + ' input(s)',
                        ['Each input reads its days once and stops by itself at ' + stop + ' UTC.',
                         next].concat(metaNote));
                    state.form = null;
                } else {
                    var notCreated = plan.inputs.slice(out.done.length).map(function (it) { return it.name; });
                    flash('error', 'Created ' + out.done.length + ' of ' + plan.inputs.length +
                        ' inputs, then one failed',
                        [explain(out.failed.resp),
                         'Not created: ' + notCreated.join(', ') + '.',
                         'Nothing was retried. The inputs that were created are running. To finish, ' +
                         'create the same selection again under a new job name: the days those ' +
                         'inputs cover are skipped.'].concat(metaNote));
                }
                reload();
            });
        }).catch(function (e) {
            inFlight = false;
            console.warn('LogServ S3 Direct: create error', e);
            flash('error', 'Could not create the backfill', ['The request did not complete. ' +
                'Re-check the list before retrying — do not assume nothing was created.']);
        });
    }

    /**
     * The UCC endpoint has no _meta field, so the create cannot carry the
     * cloud_provider stamp every SQS input on the fleet has. This TA's own
     * endpoint writes it and restarts the input (see META_EP). Resolves '' once
     * stamped, otherwise a short reason for the note - that endpoint's own
     * message when it answered, which also says when the stamp was written but
     * not yet applied - so the operator is never left with
     * differently-attributed data and no idea why (L3-08). A request that
     * never answered is NOT a stamp.
     */
    function stampMeta(name) {
        return req(META_EP, { method: 'POST', body: formEncode({ name: name }) }, true)
            .then(function (r) {
                if (r.ok) { return ''; }
                console.warn('LogServ S3 Direct: stamp refused', name, r.status, r.text);
                var own = r.json && typeof r.json.error === 'string' ? r.json.error : '';
                return own || ('HTTP ' + r.status);
            })
            .catch(function () { return 'no response'; });
    }

    /* Enable or disable one input through the add-on's UCC endpoint: a POST
     * that carries only "disabled" goes straight to the native disable or
     * enable action (splunktaucclib admin_external.handleEdit), with no field
     * validation, and this endpoint is one the proxy passes (section 18.11). */
    function toggleReq(name, action) {
        return req(S3_EP + '/' + pathSeg(name),
            { method: 'POST', body: formEncode({ disabled: action === 'disable' ? '1' : '0' }) }, true);
    }

    function toggleInput(rec) {
        if (inFlight) { return; }
        inFlight = true;
        var action = rec.disabled ? 'enable' : 'disable';
        toggleReq(rec.name, action)
            .then(function (r) {
                inFlight = false;
                if (!r.ok) {
                    console.warn('LogServ S3 Direct: toggle failed', r.status, r.text);
                    return flash('error', 'Could not ' + action + ' ' + rec.name, [explain(r)]);
                }
                flash('ok', rec.name + ' ' + action + 'd', action === 'disable'
                    ? ['Disabling stops further polling. It does not resume an interrupted run — ' +
                       'the add-on will not re-fetch objects it has already passed.']
                    : []);
                reload();
            }).catch(function () {
                inFlight = false;
                flash('error', 'Could not ' + action + ' ' + rec.name, ['The request did not complete.']);
            });
    }

    function toggleJob(job, members, action) {
        if (inFlight) { return; }
        var targets = members.filter(function (m) {
            return action === 'enable' ? m.rec.disabled : !m.rec.disabled;
        });
        if (!targets.length) { return; }
        inFlight = true;
        sequential(targets, function (m) {
            return toggleReq(m.rec.name, action);
        }).then(function (out) {
            inFlight = false;
            if (out.failed) {
                console.warn('LogServ S3 Direct: job toggle failed', out.failed.resp && out.failed.resp.status);
                flash('error', 'Could not ' + action + ' every input of ' + job,
                    [explain(out.failed.resp || {}), action + 'd ' + out.done.length + ' of ' +
                     targets.length + ' before it stopped.']);
            } else {
                flash('ok', job + ': ' + targets.length + ' input(s) ' + action + 'd', action === 'disable'
                    ? ['Disabling stops further polling and keeps the record, so later backfills ' +
                       'still skip these days. It does not resume an interrupted run.']
                    : []);
            }
            reload();
        }).catch(function () {
            inFlight = false;
            flash('error', 'Could not ' + action + ' ' + job, ['The request did not complete.']);
        });
    }

    function deleteJob(job, members) {
        if (inFlight) { return; }
        var msg = 'Delete the ' + members.length + ' input(s) of backfill ' + job + '?\n\n' +
            'This does not remove any events already indexed. It does make these days eligible ' +
            'again: a later backfill of the same dashboards and days would read them a second time. ' +
            'To stop this backfill but keep that record, use Disable all instead.';
        if (!window.confirm(msg)) { return; }
        inFlight = true;
        sequential(members, function (m) {
            return req(S3_EP + '/' + pathSeg(m.rec.name), { method: 'DELETE' }, true);
        }).then(function (out) {
            inFlight = false;
            if (out.failed) {
                console.warn('LogServ S3 Direct: job delete failed', out.failed.resp && out.failed.resp.status);
                flash('error', 'Could not delete every input of ' + job,
                    [explain(out.failed.resp || {}), 'Deleted ' + out.done.length + ' of ' +
                     members.length + ' before it stopped.']);
            } else {
                flash('ok', 'Deleted backfill ' + job + ' (' + members.length + ' input(s))', []);
            }
            reload();
        }).catch(function () {
            inFlight = false;
            flash('error', 'Could not delete ' + job, ['The request did not complete.']);
        });
    }

    function confirmDelete(rec, foreign) {
        if (inFlight) { return; }
        var msg = 'Delete ' + rec.name + '?\n\n' +
            'This does not remove any events already indexed. If you recreate an input with ' +
            'the same name, the add-on resets its checkpoint and re-ingests everything under ' +
            'the prefix a second time.';
        if (foreign) {
            msg += '\n\nThis input was NOT created by this screen. Type the name to confirm.';
            var typed = window.prompt(msg, '');
            if (typed !== rec.name) { return; }
        } else if (!window.confirm(msg)) {
            return;
        }
        inFlight = true;
        req(S3_EP + '/' + pathSeg(rec.name), { method: 'DELETE' }, true).then(function (r) {
            inFlight = false;
            if (!r.ok) {
                console.warn('LogServ S3 Direct: delete failed', r.status, r.text);
                return flash('error', 'Could not delete ' + rec.name, [explain(r)]);
            }
            flash('ok', 'Deleted ' + rec.name, []);
            reload();
        }).catch(function () {
            inFlight = false;
            flash('error', 'Could not delete ' + rec.name, ['The request did not complete.']);
        });
    }

    /* ---------------------------------------------------------------- *
     * Gating and top-level render
     * ---------------------------------------------------------------- */

    /* The last outcome is kept in state so it survives the reload that
     * follows every write: render() rebuilds the page, flash box included,
     * and a create's "next step" must still be on screen afterwards. */
    var flashBox = null;
    function paintFlash() {
        if (!flashBox) { return; }
        clear(flashBox);
        if (state.flash) {
            flashBox.appendChild(banner(state.flash.kind, state.flash.title, state.flash.lines));
        }
    }
    function flash(kind, title, lines) {
        state.flash = { kind: kind, title: title, lines: lines || [] };
        paintFlash();
    }

    function ackKey(env) { return ACK_KEY_BASE + (env.guid || 'unknown'); }

    function tierGate(container, env) {
        /* Gate A — Splunk-managed instance. Never write from here. */
        if (env.isCloud) {
            container.appendChild(banner('warn', 'This is a Splunk-managed instance',
                ['Direct S3 polling runs on the instance that holds the input, so it belongs on ' +
                 'a heavy forwarder you manage. This screen will not write here; use the ' +
                 'generated configuration below on your forwarder.']));
            env.mode = 'assisted';
            return true;
        }
        /* Gate B — positive evidence this instance already ingests from AWS. */
        if (env.hasEnabledAwsInput) { return true; }
        /* Gate C — no evidence either way; acknowledge once per instance. */
        var acked = false;
        try { acked = window.localStorage.getItem(ackKey(env)) === '1'; } catch (e) { acked = false; }
        if (acked) { return true; }

        container.appendChild(banner('warn', 'No AWS inputs are configured on this instance',
            ['An input created here polls S3 from THIS instance and forwards from here. On a ' +
             'search head or an indexer that is usually not what you want — create it on the ' +
             'heavy forwarder that already collects your LogServ data.',
             'If another instance already polls this bucket and prefix, both will ingest it and ' +
             'you will get duplicate events. Nothing on this screen can detect that.']));
        var bar = el('div', { cls: 'logserv-s3-actions' });
        bar.appendChild(el('button', {
            type: 'button', cls: 'btn btn-primary', text: 'Create inputs here anyway',
            onclick: function () {
                try { window.localStorage.setItem(ackKey(env), '1'); } catch (e) { /* ignore */ }
                render();
            }
        }));
        container.appendChild(bar);
        return false;
    }

    function render() {
        var env = state.env;
        clear(root);

        flashBox = el('div');
        root.appendChild(flashBox);
        paintFlash();

        root.appendChild(el('p', {
            cls: 'logserv-s3-lede',
            text: 'Generic S3 polls a bucket prefix directly, with no queue. Use it for backfill, ' +
                'for outage recovery, and for buckets with no notification wiring. SQS-Based S3 ' +
                'remains the steady-state channel. Choose dashboards and a range of UTC days, and ' +
                'this screen builds the S3 keys.'
        }));

        /* Dependency present? A disabled app is not usable (L1-03). */
        if (!env.awsTaPresent) {
            if (env.isDS) {
                /* Do NOT report a missing dependency here: the obvious
                 * remediation would be to install the AWS TA on the DS, which
                 * is the one tier this must not run on (L1-04). */
                root.appendChild(banner('warn', 'This is a deployment server',
                    ['Direct S3 polling runs on the instance that holds the input, so this screen ' +
                     'belongs on your heavy forwarders. Open it there.',
                     'Do not install the Splunk Add-on for AWS here to make this screen work.']));
            } else if (env.awsTaDisabled) {
                root.appendChild(banner('warn', 'The Splunk Add-on for AWS is disabled',
                    ['Enable it on this instance, then reload this page.']));
            } else {
                root.appendChild(banner('warn', 'The Splunk Add-on for AWS is not installed',
                    ['This screen configures inputs that belong to that add-on. Install it on ' +
                     'this instance, then reload this page.']));
            }
            return;
        }

        if (env.awsTaVersion && VALIDATED_TA_AWS_VERSIONS.indexOf(env.awsTaVersion) === -1) {
            root.appendChild(banner('warn',
                'Splunk Add-on for AWS ' + env.awsTaVersion + ' is not a validated version',
                ['This screen was validated against ' + VALIDATED_TA_AWS_VERSIONS.join(', ') + '. ' +
                 'Field names, the create rules and — most importantly — how the whitelist and ' +
                 'the scan window select objects may differ in this version. Verify before relying ' +
                 'on a backfill.']));
        }

        if (env.dsManagedAwsTa === true) {
            root.appendChild(banner('error', 'The AWS add-on here is managed by your deployment server',
                ['Inputs created on this screen live in that add-on’s local/inputs.conf and are ' +
                 'destroyed on the next deployment push. Add the inputs to the server-class copy ' +
                 'on your deployment server instead — the generated stanzas below are what to add.']));
            env.mode = 'assisted';
        }

        if (env.isDS) {
            root.appendChild(banner('warn', 'This instance is also a deployment server',
                ['An input created here polls from here. It is not distributed to your forwarders.']));
        }

        if (env.probeFailed) {
            root.appendChild(banner('warn', 'Could not confirm your capabilities',
                ['Showing the read-only view with generated configuration rather than risking a ' +
                 'write that would fail.']));
        }

        if (!env.accounts.length) {
            root.appendChild(banner('warn', 'No AWS accounts are configured',
                ['The Splunk Add-on for AWS is installed but has no account configured, so an ' +
                 'input cannot be created. Add one in that add-on’s Configuration → Account, ' +
                 'then reload this page.']));
            renderList(root, env);
            return;
        }

        if (!tierGate(root, env)) { renderList(root, env); return; }

        renderList(root, env);
        if (!state.form) { state.form = newForm(env); }
        renderEditor(root, env);
        renderVerify(root, env);
    }

    /* Built from no form state on purpose. Until session 136 this section also
     * held an event count over the form's dates; it was drawn once per render,
     * so it went stale while the form was edited and showed the reset form's
     * default week after a create - never the backfill just made. Each backfill
     * in the list now carries its own two searches (section 18.11). */
    function renderVerify(container, env) {
        var section = el('div', { cls: 'logserv-s3-section' });
        section.appendChild(el('h3', { text: 'Did the backfill actually land?' }));
        section.appendChild(el('p', {
            text: 'The add-on keeps run state in a checkpoint file this screen cannot read, so a ' +
                'backfill past its stop time is not proof that it finished. Each backfill in the ' +
                'list above carries two searches for its own inputs and days. This one checks ' +
                'the scans of every backfill on this instance at once.'
        }));
        section.appendChild(copyable('Did the inputs finish their scan?', scanCheck(NAME_PREFIX + '*')));
        section.appendChild(el('p', {
            cls: 'logserv-s3-note',
            text: 'A backfill\'s event count covers every event in its window, including any the ' +
                'SQS-Based S3 input already delivered. Then rebuild the rollups on the search head: ' +
                'App → Settings → Dashboard Data → Custom range, with the same UTC dates, for the ' +
                'dashboards you backfilled.'
        }));
        container.appendChild(section);
    }

    function reload() {
        probe().then(function (env) {
            state.env = env;
            if (!state.form) { state.form = newForm(env); }
            render();
        });
    }

    /* ---------------------------------------------------------------- *
     * Entry
     * ---------------------------------------------------------------- */

    function boot() {
        clear(root);
        root.appendChild(el('p', { text: 'Checking this instance…' }));
        probe().then(function (env) {
            state.env = env;
            state.form = newForm(env);
            render();
        }).catch(function (e) {
            console.error('LogServ S3 Direct: probe failed', e);
            clear(root);
            root.appendChild(banner('error', 'Could not read this instance',
                ['See the browser console for detail.']));
        });
    }

    /**
     * Wait for the panel before starting.
     *
     * Splunk renders a SimpleXML <html> panel's content ASYNCHRONOUSLY, after
     * this script has already been evaluated, so the root div is not guaranteed
     * to exist yet. DOMContentLoaded does not help: the document is complete
     * well before the panel is. Poll, and say so in the console if the panel
     * never appears rather than failing silently.
     *
     * (The "Loading…" placeholder that the session-117 rendered pass found
     * stuck forever was NOT this — it was the anonymous define() described at
     * the top of the file, which meant none of this code ever ran. This poll is
     * defensive, not the fix.)
     */
    function start() {
        var tries = 0;
        (function awaitRoot() {
            root = document.getElementById(ROOT_ID);
            if (root) { boot(); return; }
            if (tries < MAX_ROOT_TRIES) {
                tries += 1;
                window.setTimeout(awaitRoot, ROOT_POLL_MS);
                return;
            }
            console.warn('LogServ S3 Direct: panel root #' + ROOT_ID +
                ' never appeared after ' + (MAX_ROOT_TRIES * ROOT_POLL_MS / 1000) + 's');
        }());
    }

    start();

    window[LOADED_FLAG] = true;
    return { start: start };
}());
