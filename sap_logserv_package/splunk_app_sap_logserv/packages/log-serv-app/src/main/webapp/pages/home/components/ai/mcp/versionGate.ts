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
 * No upper bound (build 393, 2026-10-20 - the user: newer versions of
 * another app must not be blocked). Builds 83-392 refused to operate
 * against App 7931 at or above an "uncertified" major (2.0.0, then
 * 3.0.0 from build 335), replacing the chat with a setup card. A newer
 * Splunk MCP Server is now accepted. What has been verified: 2.0.0 -
 * the `initialize` handshake in the field, and `tools/list` /
 * `tools/call` against a live server (manual operator check,
 * 2026-09-17, session 123); not later minors, not 3.x. If a later
 * major changes the protocol shape the AI Assistant depends on, that
 * shows as failing tool calls in the chat rather than as a refusal to
 * start.
 */

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
 * "older" — fail closed on parse error). A two-part version ("3.0")
 * reads as MAJOR.MINOR.0 (build 393); it used to be refused as malformed.
 */
export const meetsMinVersion = (
    installed: string,
    required: string = MIN_MCP_SERVER_VERSION,
): boolean => {
    if (!installed || !installed.match(/^\d+\.\d+/)) return false;
    return compareVersions(installed, required) >= 0;
};

const parseSemver = (v: string): [number, number, number] => {
    // Strip a `-prerelease` suffix.
    const core = v.split('-')[0] ?? v;
    const parts = core.split('.').map((n) => parseInt(n, 10));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};
