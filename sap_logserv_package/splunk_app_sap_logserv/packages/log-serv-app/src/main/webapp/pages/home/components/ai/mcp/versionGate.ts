/**
 * Version gate for the Splunk MCP Server (App 7931).
 *
 * Enforces the design's hard rule: any v < 1.0.3 has CVE-2026-20205
 * (token-leak in `_internal`) and we refuse to operate against it.
 * The user-facing setup wizard surfaces an upgrade link.
 *
 * See `ai_assistant_design_v0.1_20260427.md` §4.2, §9.1 (CVE row).
 */

/**
 * Minimum required version of App 7931. Bump this whenever a new
 * security-relevant fix lands and we want to require the upgrade.
 */
export const MIN_MCP_SERVER_VERSION = '1.0.3';

/**
 * Exclusive upper bound on App 7931 versions we have tested against.
 * Any version `>= MAX_MCP_SERVER_VERSION_EXCLUSIVE` is considered
 * uncertified and the AI Assistant refuses to operate against it
 * until we explicitly re-cert.
 *
 * Rationale (OWASP LLM03 Supply Chain — build 83 / Appendix D #8):
 * a Splunk MCP Server major-version bump (e.g. 1.x → 2.x) is allowed
 * to break the protocol shape we depend on (request/response
 * structure, tool naming, error envelope). Without an upper bound a
 * field upgrade of App 7931 could silently degrade the AI Assistant
 * — admins would see broken tool dispatches with no clear cause.
 *
 * Bump this when the team has validated the next major against the
 * AI Assistant's expectations and updated MCPClient as needed.
 */
export const MAX_MCP_SERVER_VERSION_EXCLUSIVE = '2.0.0';

/**
 * Compare two semver-shaped strings ("MAJOR.MINOR.PATCH" with
 * optional "-pre" suffix). Returns:
 *   < 0  if a < b
 *   = 0  if a == b
 *   > 0  if a > b
 *
 * Pre-release suffixes are ignored for comparison purposes — a build
 * tagged `1.0.3-rc1` is treated as `1.0.3` for the version gate. This
 * is intentional: customers running release candidates of a fixed
 * version should not be locked out.
 */
export const compareVersions = (a: string, b: string): number => {
    const na = parseSemver(a);
    const nb = parseSemver(b);
    if (na[0] !== nb[0]) return na[0] - nb[0];
    if (na[1] !== nb[1]) return na[1] - nb[1];
    return na[2] - nb[2];
};

/**
 * Returns `true` if `installed` is greater than or equal to `required`.
 * Returns `false` if `installed` is missing/malformed (treated as
 * "older" — fail closed on parse error).
 */
export const meetsMinVersion = (
    installed: string,
    required: string = MIN_MCP_SERVER_VERSION,
): boolean => {
    if (!installed || !installed.match(/^\d+\.\d+\.\d+/)) return false;
    return compareVersions(installed, required) >= 0;
};

/**
 * Returns `true` if `installed` is strictly less than `maxExclusive`.
 * Returns `false` if `installed` is missing/malformed (fail closed —
 * an unparseable version string can't be confidently bounded).
 *
 * Used to enforce the upper version bound on App 7931. A `false`
 * return means the installed version is at or beyond the exclusive
 * cap and the caller should refuse to operate.
 */
export const belowMaxVersion = (
    installed: string,
    maxExclusive: string = MAX_MCP_SERVER_VERSION_EXCLUSIVE,
): boolean => {
    if (!installed || !installed.match(/^\d+\.\d+\.\d+/)) return false;
    return compareVersions(installed, maxExclusive) < 0;
};

const parseSemver = (v: string): [number, number, number] => {
    // Strip a `-prerelease` suffix.
    const core = v.split('-')[0] ?? v;
    const parts = core.split('.').map((n) => parseInt(n, 10));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};
