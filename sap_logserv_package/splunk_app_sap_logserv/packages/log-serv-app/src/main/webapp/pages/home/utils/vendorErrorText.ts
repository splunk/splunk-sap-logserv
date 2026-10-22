/**
 * vendorErrorText - what the AI vendor is told when a tool call fails
 * (build 376 / session 149).
 *
 * The privacy rule: no event data, and no text that Splunk or the MCP
 * server wrote, reaches an AI vendor - in any tier. A Splunk error message
 * echoes the search that failed, and that search can carry event data a
 * subsearch put there: `| inputlookup [search ... | eval v=substr(_raw,1,80)
 * | return $v]` fails with an error that names the "lookup table" - the
 * first 80 characters of an event. Before this build both tier summaries
 * sent up to 200 characters of that message to the vendor.
 *
 * So a failed tool call reaches the vendor as a FIXED string, built only
 * from two things:
 *
 *   - the HTTP status, when it is an integer from 100 to 599 (printed as
 *     digits; anything else is dropped), and
 *   - one class name from VENDOR_ERROR_CLASSES, picked by fixed regexes
 *     over the message (or, when none matches, by the status).
 *
 * The output never contains any part of the message: the message only
 * selects which of the fixed strings is returned. The full message is still
 * shown to the user (ToolResultPanel) and kept in the result object; only
 * the vendor-bound summary is reduced.
 *
 * App-authored refusals - the synthetic error results the hook builds
 * itself when it refuses a call before sending it (the splGuard verdict,
 * the saved-search allow-list and undeclared-tool verdict, the session
 * tool-call cap) - carry no data, and the model needs their reason to
 * rephrase. They are passed through by `vendorRefusalText`, which the hook
 * calls AT THE REFUSAL SITE with the reason it just wrote. It is never
 * applied to a result that came back from the server, so a server message
 * that imitates a refusal is classified like any other error.
 *
 * Pure module: no imports, no JSON - it is loaded by the build gate.
 */

/** Every class the vendor can be told. Order is the display order only. */
export const VENDOR_ERROR_CLASSES = [
    'parse_error',
    'unknown_command',
    'missing_lookup',
    'missing_saved_search',
    'permission',
    'timeout',
    'rate_limited',
    'not_found',
    'server_error',
    'other',
] as const;

export type VendorErrorClass = (typeof VENDOR_ERROR_CLASSES)[number];

/** The shape `detectToolError` returns; fields are typed loosely on purpose
 *  - a status that is not a sane integer is dropped, not trusted. */
export interface ToolErrorInput {
    statusCode?: unknown;
    message?: unknown;
}

/** Only this much of a message is classified - the regexes below scan with
 *  `[\s\S]*`, and a megabyte of error text must not cost a quadratic scan.
 *  It changes which class is picked, never what is sent. */
export const CLASSIFY_MAX_CHARS = 2000;

/**
 * Message rules, first match wins. More specific classes come first: a
 * Splunk "Error in 'inputlookup' command: The lookup table ... requires a
 * .csv or KV store lookup definition" is a missing lookup, not a parse
 * error. No flag `g` - a stateless `test()` on every call.
 */
const MESSAGE_RULES: ReadonlyArray<{ cls: VendorErrorClass; re: RegExp }> = [
    {
        cls: 'missing_saved_search',
        re: /saved[\s_-]*search\b[\s\S]{0,200}?\b(?:not\s+found|(?:does\s+not|doesn't)\s+exist|cannot\s+be\s+found|could\s+not\s+be\s+found|no\s+longer\s+exists)|(?:cannot|can't|could\s+not|unable\s+to)\s+find\s+(?:the\s+)?saved[\s_-]*search|\bno\s+such\s+saved[\s_-]*search|\bunknown\s+saved[\s_-]*search/i,
    },
    {
        cls: 'missing_lookup',
        re: /lookup\s+table\b[\s\S]{0,300}?\b(?:requires\s+a\s+\.csv|(?:does\s+not|doesn't)\s+exist|not\s+found|is\s+not\s+available)|could\s+not\s+(?:construct|find)\s+(?:all\s+of\s+the\s+specified\s+)?lookup|lookup\s+definition\b[\s\S]{0,200}?\b(?:not\s+found|(?:does\s+not|doesn't)\s+exist)|\bno\s+such\s+lookup/i,
    },
    {
        cls: 'unknown_command',
        re: /unknown\s+search\s+command|\bunknown\s+command\b|search\s+command\b[\s\S]{0,200}?\bnot\s+found|is\s+not\s+a\s+(?:known|valid)\s+(?:search\s+)?command/i,
    },
    {
        cls: 'permission',
        re: /\bpermission|\bforbidden\b|\bnot\s+authori[sz]ed|\bunauthori[sz]ed|\baccess\s+(?:is\s+)?denied|\binsufficient\s+(?:privileges?|permissions?|capabilit)|(?:does\s+not|doesn't|do\s+not|don't)\s+have\s+(?:the\s+)?(?:sufficient\s+|required\s+)?(?:capabilit|permission|privilege|access)/i,
    },
    {
        cls: 'timeout',
        re: /\btimed?\s*-?\s*out\b|\btimeout\b|\bdeadline\s+exceeded|\bsignal\s+is\s+aborted|\btook\s+too\s+long/i,
    },
    {
        cls: 'rate_limited',
        re: /\brate[\s-]*limit|\btoo\s+many\s+(?:requests|searches|concurrent)|\bquota\b|\bmaximum\s+number\s+of\s+concurrent|\bconcurren(?:t|cy)\s+(?:search\s+)?limit/i,
    },
    {
        cls: 'parse_error',
        re: /\bunable\s+to\s+parse|\bparse\s+error|\bparsing\b|\bsyntax\b|\bunbalanced\b|\bmalformed\b|\binvalid\s+(?:argument|option|search|spl|query|expression|term|value)|\bexpected\b|\bmissing\s+(?:required\s+)?(?:argument|parameter|field|option)/i,
    },
    {
        cls: 'not_found',
        re: /\bnot\s+found\b|(?:does\s+not|doesn't)\s+exist|\bno\s+such\b|\bunknown\s+(?:tool|method|resource|endpoint)/i,
    },
    {
        cls: 'server_error',
        re: /\binternal\s+(?:server\s+)?error|\bserver\s+error|\bservice\s+unavailable|\bbad\s+gateway|\bexception\b|\btraceback\b/i,
    },
];

/** The status as a number the vendor may see, or undefined. Only an
 *  integer 100..599 - never a string, never NaN or a fraction. */
export const normalizeStatus = (statusCode: unknown): number | undefined =>
    typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
        ? statusCode
        : undefined;

/** The class for a status when no message rule matched. */
const classFromStatus = (status: number | undefined): VendorErrorClass => {
    if (status === undefined) return 'other';
    if (status === 401 || status === 403) return 'permission';
    if (status === 404 || status === 410) return 'not_found';
    if (status === 408 || status === 504) return 'timeout';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'other';
};

/** Pick the class of a failed tool call. Reads the message locally; the
 *  message never leaves this function. */
export const classifyToolError = (statusCode: unknown, message: unknown): VendorErrorClass => {
    const text = typeof message === 'string' ? message.slice(0, CLASSIFY_MAX_CHARS) : '';
    if (text.length > 0) {
        for (const rule of MESSAGE_RULES) {
            if (rule.re.test(text)) return rule.cls;
        }
    }
    return classFromStatus(normalizeStatus(statusCode));
};

/** A fixed, App-written hint per class, so the model can still react
 *  (rephrase, narrow the window, pick a catalog name). */
const CLASS_HINTS: Readonly<Record<VendorErrorClass, string>> = {
    parse_error: 'Splunk could not parse the query; check the SPL syntax.',
    unknown_command: 'the query uses a command this Splunk does not know.',
    missing_lookup: 'the query names a lookup that does not exist here.',
    missing_saved_search: 'the saved search was not found; use a catalog name exactly as written.',
    permission: 'the Splunk user is not permitted to do this.',
    timeout: 'the search timed out; narrow the time range or simplify the query.',
    rate_limited: 'Splunk refused the search under a rate or concurrency limit; use fewer calls.',
    not_found: 'the requested object was not found.',
    server_error: 'the Splunk MCP server reported an internal error.',
    other: 'the tool call failed.',
};

/** Said after every error, so the model does not ask for the text. */
export const ERROR_TEXT_PRIVATE_NOTE = 'The error text is shown to the user only.';

/** The vendor string for a status and class - the only strings
 *  `vendorToolErrorText` can return. */
export const formatVendorToolError = (status: number | undefined, cls: VendorErrorClass): string => {
    const head = status !== undefined ? `HTTP ${status}, class=${cls}` : `class=${cls}`;
    return `Tool error (${head}): ${CLASS_HINTS[cls]} ${ERROR_TEXT_PRIVATE_NOTE}`;
};

/**
 * The vendor-bound text for an error detected in a tool RESULT (anything
 * the MCP server or Splunk returned, and anything thrown into one). A
 * function of the normalized status and the class only.
 */
export const vendorToolErrorText = (detected: ToolErrorInput | null | undefined): string => {
    const statusCode = detected ? detected.statusCode : undefined;
    const message = detected ? detected.message : undefined;
    return formatVendorToolError(normalizeStatus(statusCode), classifyToolError(statusCode, message));
};

/* ---------------------------- App-authored refusals ---------------------------- */

/** Prefix of every refusal the vendor is told. */
export const REFUSAL_PREFIX = 'Tool call refused by the App before it ran: ';

/** Refusal reasons are a few hundred characters; this only bounds them. */
export const REFUSAL_MAX_CHARS = 1000;

/** Fallback when a refusal site has no reason. */
export const REFUSAL_FALLBACK = 'the call was not permitted.';

const REFUSAL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const REFUSAL_SENTINEL_RE = /<\/?TOOL_RESULT_DATA>/gi;

/**
 * The vendor-bound text for a refusal the HOOK wrote. Call it only at a
 * refusal site, with the reason the hook just put in its synthetic result
 * - never with text taken from a tool result. The reason is App-written
 * (it may quote the model's own tool name or saved-search name, which the
 * model sent); control characters become spaces and the data-block tags
 * are neutralized, so the reason cannot close the block it is sent in.
 */
export const vendorRefusalText = (reason: string): string => {
    const raw = typeof reason === 'string' && reason.length > 0 ? reason : REFUSAL_FALLBACK;
    const cleaned = raw.replace(REFUSAL_CONTROL_RE, ' ').replace(REFUSAL_SENTINEL_RE, '<filtered>');
    const bounded = cleaned.length > REFUSAL_MAX_CHARS ? `${cleaned.slice(0, REFUSAL_MAX_CHARS - 3)}...` : cleaned;
    return REFUSAL_PREFIX + bounded;
};
