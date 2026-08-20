/**
 * reactText — best-effort plain-text extraction from a ReactNode-shaped value
 * (session 097 follow-up, design §14.6; build 313).
 *
 * WHY THIS EXISTS AS A `.ts` UTIL RATHER THAN A HELPER INSIDE FramedPanel:
 * `bin/check-diagnostics.js` resolves relative imports as `.ts` only, so logic
 * living in a `.tsx` component is outside the build gate's reach — exactly the
 * class of change session 097 proved needs more than review (the Diagnostics
 * completion-handler bug sat behind 550+ green gate checks because no suite
 * can render a component). The extractable part is therefore extracted, and
 * `reactText.consistency-test.ts` pins it.
 *
 * DELIBERATELY REACT-FREE. The walk is structural: strings and numbers
 * contribute text, arrays recurse, and anything object-shaped with a
 * `props.children` field (a React element or fragment) recurses into the
 * children. Booleans / null / undefined render nothing in React and contribute
 * nothing here. An element tree with NO text content yields `undefined` — the
 * caller treats that exactly like "no title" (the honest "(untitled)" fallback
 * in the report), never an empty-string title.
 *
 * The depth cap is defensive only: panel titles are a handful of nodes, and a
 * cap turns any pathological or cyclic structure into a truncated-but-safe
 * answer instead of a stack overflow.
 */

const MAX_DEPTH = 8;

export const textFromNode = (node: unknown): string | undefined => {
    const parts: string[] = [];
    const walk = (n: unknown, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        if (n === null || n === undefined || typeof n === 'boolean') return;
        if (typeof n === 'string') {
            if (n.length > 0) parts.push(n);
            return;
        }
        if (typeof n === 'number') {
            parts.push(String(n));
            return;
        }
        if (Array.isArray(n)) {
            n.forEach((c) => walk(c, depth + 1));
            return;
        }
        if (typeof n === 'object') {
            const props = (n as { props?: unknown }).props;
            if (props && typeof props === 'object') {
                walk((props as { children?: unknown }).children, depth + 1);
            }
        }
    };
    walk(node, 0);
    const joined = parts.join('').trim();
    return joined.length > 0 ? joined : undefined;
};
