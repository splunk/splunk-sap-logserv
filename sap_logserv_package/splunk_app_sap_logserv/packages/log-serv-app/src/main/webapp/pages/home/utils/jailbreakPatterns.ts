/**
 * jailbreakPatterns — pre-flight analysis of user prompts to flag
 * known jailbreak / prompt-injection patterns for SOC observability.
 *
 * Implements OWASP LLM01 (Prompt Injection) Appendix D recommendation
 * #11: pre-flight check on user input that flags known jailbreak
 * patterns + audit-log every user prompt with a hash + length +
 * character-class fingerprint for post-hoc review.
 *
 * Behavior is **flag-and-proceed**, not reject:
 *   - Pattern check runs in `useAIAssistant.sendUserMessage` BEFORE
 *     the rate-limit check.
 *   - On match: fires a `user_prompt_jailbreak_flag` audit event.
 *   - The prompt still proceeds normally to the AI vendor.
 *   - Defense-in-depth: the type system (`Hidden<T>`) + tier2Summary
 *     value sanitizer + tool-result `<TOOL_RESULT_DATA>` sentinel +
 *     primer instructions + Anthropic's own model-layer defenses
 *     already neutralize the in-band injection vector. This file
 *     adds SOC observability for the user-prompt vector that wasn't
 *     previously logged.
 *
 * Why flag-and-proceed (not reject):
 *   Regex pattern matching has false positives — a security analyst
 *   could legitimately ask "show me events where the user tried to
 *   ignore prior warnings" and trip the regex. Rejecting would
 *   cripple legitimate investigative use. Logging gives the SOC team
 *   data for review without blocking work.
 *
 * Build 87 / session 020.
 */

const ROLE_REDEFINITION_PATTERNS = [
    'ignore (?:all )?(?:prior|previous|above) instructions',
    'disregard (?:the |all |any )?(?:above|prior|previous)',
    'forget (?:everything|all|your) (?:above|prior|previous|instructions)',
    '\\[INST\\]',
    '\\[\\[INST\\]\\]',
    '<<SYS>>',
    'jailbreak',
    'DAN mode',
    'developer mode',
];

const PERSONA_SHIFT_PATTERNS = [
    'you are now (?:a |an )?',
    'from now on,? you (?:are|will|must)',
    'pretend (?:to be|you are)',
    'roleplay as',
    'respond as if you (?:are|were)',
];

const SYSTEM_PROMPT_LEAK_PATTERNS = [
    'repeat your (?:system )?(?:prompt|instructions)',
    'show me your (?:system )?(?:prompt|instructions|rules)',
    'what (?:are|is) your (?:system )?(?:prompt|instructions|rules)',
    'print your (?:system )?(?:prompt|instructions)',
    'reveal your (?:system )?(?:prompt|instructions)',
];

const CONTROL_TOKEN_PATTERN = '<\\|[a-z_]+\\|>';

const PATTERN_GROUPS: Array<{ name: string; re: RegExp }> = [
    {
        name: 'role_redefinition',
        re: new RegExp(ROLE_REDEFINITION_PATTERNS.join('|'), 'i'),
    },
    {
        name: 'persona_shift',
        re: new RegExp(PERSONA_SHIFT_PATTERNS.join('|'), 'i'),
    },
    {
        name: 'system_prompt_leak',
        re: new RegExp(SYSTEM_PROMPT_LEAK_PATTERNS.join('|'), 'i'),
    },
    {
        name: 'control_token',
        re: new RegExp(CONTROL_TOKEN_PATTERN, 'i'),
    },
    {
        // Long contiguous base64-shaped runs — common smuggling vector
        // for encoded payloads. 100+ chars is well above any normal
        // English word length and a strong signal of intent. False
        // positive is possible (a real base64-encoded screenshot or
        // certificate fragment) — flagged-but-not-blocked is the right
        // posture here.
        name: 'long_base64_blob',
        re: /[A-Za-z0-9+/=]{100,}/,
    },
];

export interface CharClassFingerprint {
    /** Percentage of characters that are letters (A-Z, a-z). */
    alpha: number;
    /** Percentage that are digits (0-9). */
    digit: number;
    /** Percentage that are whitespace. */
    space: number;
    /** Percentage that are anything else (punctuation, symbols, control). */
    other: number;
}

export interface PromptAnalysis {
    /** True if at least one pattern group matched. */
    flagged: boolean;
    /** Names of pattern groups that matched. Empty when not flagged. */
    matchedGroups: string[];
    /** SHA-256 hex of the prompt text — for cross-event correlation
     *  without storing the prompt itself. Empty string if crypto.subtle
     *  unavailable (e.g., non-HTTPS context). */
    hash: string;
    /** Prompt length in characters. */
    length: number;
    /** Character-class breakdown — useful signal for spotting
     *  obfuscated prompts (very low alpha, very high other). */
    charClassFingerprint: CharClassFingerprint;
}

const sha256Hex = async (text: string): Promise<string> => {
    if (typeof crypto === 'undefined' || !crypto.subtle) return '';
    try {
        const encoded = new TextEncoder().encode(text);
        const buf = await crypto.subtle.digest('SHA-256', encoded);
        const bytes = new Uint8Array(buf);
        let hex = '';
        for (let i = 0; i < bytes.length; i += 1) {
            const h = bytes[i].toString(16);
            hex += h.length === 1 ? `0${h}` : h;
        }
        return hex;
    } catch {
        return '';
    }
};

const computeCharClassFingerprint = (text: string): CharClassFingerprint => {
    let alpha = 0;
    let digit = 0;
    let space = 0;
    let other = 0;
    for (const ch of text) {
        if (/[a-zA-Z]/.test(ch)) alpha += 1;
        else if (/[0-9]/.test(ch)) digit += 1;
        else if (/\s/.test(ch)) space += 1;
        else other += 1;
    }
    const total = text.length || 1;
    return {
        alpha: Math.round((alpha / total) * 100),
        digit: Math.round((digit / total) * 100),
        space: Math.round((space / total) * 100),
        other: Math.round((other / total) * 100),
    };
};

/**
 * Pre-flight analyze a user prompt. Returns a structured analysis the
 * caller can inspect (`flagged`?) and pass through to the audit event.
 *
 * Async because SHA-256 hashing uses `crypto.subtle.digest`. Cost is
 * trivially small for normal prompts (regex check + a 32-byte hash);
 * don't call in a hot loop, but per-prompt is fine.
 */
export const analyzeUserPrompt = async (text: string): Promise<PromptAnalysis> => {
    const matchedGroups: string[] = [];
    for (const g of PATTERN_GROUPS) {
        if (g.re.test(text)) matchedGroups.push(g.name);
    }
    const hash = await sha256Hex(text);
    return {
        flagged: matchedGroups.length > 0,
        matchedGroups,
        hash,
        length: text.length,
        charClassFingerprint: computeCharClassFingerprint(text),
    };
};
