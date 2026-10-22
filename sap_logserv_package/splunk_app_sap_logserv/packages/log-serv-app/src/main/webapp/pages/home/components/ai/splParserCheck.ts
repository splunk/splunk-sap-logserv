/**
 * splParserCheck - the check every AI-authored ad-hoc query passes before it
 * is sent to the MCP server (App build 377).
 *
 *   1. `analyzeAdHocSpl` (utils/splGuard.ts): the denylist, the data scope
 *      and the command allow-list, on the App's own strict lexer.
 *   2. Splunk's own search parser reads the same query - `search/parser`
 *      with parse_only, the endpoint App 7931 itself runs on every MCP query
 *      - through Splunk Web's splunkd proxy, as the user, in this App's
 *      namespace (the cookie session, like the App's other REST calls).
 *   3. `checkParserAgreement`: the two readings must agree, command for
 *      command, and the parser may report no command that is not allowed.
 *      For a query that starts with the data macro this also catches a
 *      macro of the same name that the dispatching user's context shadows
 *      (the parser expands the macro in effect); where the macro stands
 *      after WHERE in tstats or starts a subsearch, only an index term its
 *      expansion brings in is caught. Since build 378 the lookup of every
 *      top-level `lookup` / `inputlookup` is read again from the parser's
 *      raw arguments and must be one of the App's (`parserLookupName`).
 *
 * It fails closed. A parser call that cannot be made, fails, times out or
 * returns no command list refuses the query (`parser_unavailable`; the hook
 * records no audit event when the user stopped the turn); a query the parser
 * rejects as invalid SPL (HTTP 400) is refused too (`parser_rejected`). The
 * refusal text is the App's own: no Splunk message text is passed on. The
 * only words of the reply that can reach the AI vendor are one command name
 * a `parser_mismatch` quotes - a command the parser reported, through
 * `safeName` (letters, digits, `_ . : -`, at most 64 characters).
 *
 * The request and the reply handling are pure functions
 * (`buildParserRequest`, `interpretParserReply`) so the consistency suite can
 * run them; `vetAdHocQuery` only joins them with a fetch and a timeout.
 */
import {
    AdHocSplAnalysis,
    SplAnalysisResult,
    analyzeAdHocSpl,
    checkParserAgreement,
    parserRejected,
    parserUnavailable,
} from '../../utils/splGuard';

const APP_NAMESPACE = 'splunk_app_sap_logserv';

/** How long the parser call may take before the query is refused. */
export const PARSER_TIMEOUT_MS = 15000;

/** Splunk Web's CSRF cookie, the same reader as utils/auditQuery.ts. */
const readCsrfToken = (): string => {
    if (typeof document === 'undefined') return '';
    const m = `; ${document.cookie}`.match(/; splunkweb_csrf_token_\d+=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
};

/**
 * The query as the parser reads it: a query that does not start with a
 * generating command (`|`) or an explicit `search` is the implicit search.
 */
export const parserQueryText = (query: string): string => {
    const q = query.trim();
    if (q.startsWith('|') || /^search\b/i.test(q)) return q;
    return `search ${q}`;
};

/** The parser request: a POST to `search/parser` in the user's namespace of this App. */
export const buildParserRequest = (
    query: string,
    user: string,
    csrf: string,
): { url: string; init: { method: string; credentials: 'same-origin'; headers: Record<string, string>; body: string } } => {
    const owner = typeof user === 'string' && user.length > 0 && user.length <= 256 ? user : 'nobody';
    const body = new URLSearchParams();
    body.set('q', parserQueryText(query));
    body.set('parse_only', '1');
    body.set('expand_macros', '1');
    body.set('output_mode', 'json');
    return {
        url: `/en-US/splunkd/__raw/servicesNS/${encodeURIComponent(owner)}/${APP_NAMESPACE}/search/parser`,
        init: {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'X-Splunk-Form-Key': csrf,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        },
    };
};

/**
 * The verdict for a parser reply: HTTP 400 is the parser rejecting the SPL;
 * any other non-2xx status, or a body that is not JSON, is the parser being
 * unavailable; a 2xx JSON body is compared with the local reading.
 */
export const interpretParserReply = (local: AdHocSplAnalysis, status: number, bodyText: string): SplAnalysisResult => {
    if (local.blocked) return local;
    if (status === 400) return parserRejected();
    if (!(status >= 200 && status < 300)) return parserUnavailable();
    let body: unknown;
    try {
        body = JSON.parse(bodyText);
    } catch (_e) {
        return parserUnavailable();
    }
    return checkParserAgreement(local, body);
};

export interface VetOptions {
    /** The Splunk user the query runs as (its namespace resolves the macros). */
    user: string;
    /** The turn's abort signal: an aborted turn refuses the query. */
    signal?: AbortSignal;
    /** Tests: a fetch stand-in, the CSRF token and a shorter timeout. */
    fetchImpl?: (url: string, init: object) => Promise<{ status: number; text: () => Promise<string> }>;
    csrf?: string;
    timeoutMs?: number;
}

/**
 * The full check of an ad-hoc query: the local allow-list, then Splunk's
 * parser. Never throws; a failure of the parser step is a refusal.
 */
export const vetAdHocQuery = async (query: string, opts: VetOptions): Promise<SplAnalysisResult> => {
    const local = analyzeAdHocSpl(query);
    if (local.blocked) return local;
    const doFetch = opts.fetchImpl
        || ((url: string, init: object) => fetch(url, init as RequestInit) as unknown as Promise<{ status: number; text: () => Promise<string> }>);
    const { url, init } = buildParserRequest(query, opts.user, opts.csrf !== undefined ? opts.csrf : readCsrfToken());
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (opts.signal) {
        if (opts.signal.aborted) return parserUnavailable();
        opts.signal.addEventListener('abort', onAbort);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : PARSER_TIMEOUT_MS);
    });
    try {
        const call = (async (): Promise<{ status: number; text: string }> => {
            const resp = await doFetch(url, { ...init, signal: controller.signal });
            return { status: resp.status, text: await resp.text() };
        })();
        // A call still running when the timeout wins is aborted and rejects;
        // nothing waits for it any more.
        call.catch(() => undefined);
        const got = await Promise.race([call, timeout]);
        if (got === null) return parserUnavailable();
        return interpretParserReply(local, got.status, got.text);
    } catch (_e) {
        return parserUnavailable();
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
};
