/**
 * clipboard — the one copy-to-clipboard helper (extracted from
 * DiagnosticDrawerProvider in session 099 / build 314 so the Diagnostics
 * page's "Copy command" buttons share it — design §15.2).
 *
 * `navigator.clipboard` requires a secure context; the sh-idxr test box (and
 * any HTTP-only install) is not one, so the `execCommand` textarea fallback
 * is load-bearing, not legacy politeness. All window/document access is
 * call-time, so the module stays importable under node (gate-safe), though
 * calling it there is meaningless.
 */
export const copyText = (text: string): void => {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            void navigator.clipboard.writeText(text);
            return;
        }
    } catch (_e) {
        /* fall through */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
    } catch (_e) {
        /* ignore */
    }
    document.body.removeChild(ta);
};
