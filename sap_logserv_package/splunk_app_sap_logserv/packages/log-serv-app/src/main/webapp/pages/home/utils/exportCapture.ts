/**
 * exportCapture - what Download PNG / Download PDF do around html2canvas so an
 * export shows the page at rest (build 368, session 142).
 *
 * html2canvas 1.4.1 draws a CLONE of the document in a hidden iframe, and for
 * every SVG element it copies all computed styles inline onto the clone - the
 * current `transform` included. The help icon's square (DocsHelpIcon: one turn
 * over 2.4 s at each end of a 12 s cycle) is an animated <svg>, so an export
 * showed it at whatever angle it had at that instant: tilted whenever the
 * download was clicked mid-turn (4 of every 10 seconds).
 *
 *   1. pauseLiveAnimationsAtStart - THE FIX. Before html2canvas runs, pause every
 *      running CSS animation of the live page at its start, so the values copied
 *      inline are the resting ones (the square upright). The returned function
 *      puts each animation back where it was and resumes it after the capture.
 *   2. freezeAnimationsInClone - insurance. In html2canvas's onclone hook, stop
 *      every animation and transition in the clone. With html2canvas 1.4.1 the
 *      clone's own animations made no visible difference (session 142 measured
 *      it: this step alone left every mid-turn export tilted, the pause alone
 *      made all of them upright), but a later html2canvas that let them run
 *      before drawing would move the square again; stopping them costs nothing.
 *
 * The app's animations (the help icon, the loading spinners, the refresh pulse)
 * all rest in a visible state, so nothing disappears from an export. CSS
 * transitions are left alone on the live page: they end by themselves.
 */

/** Pause each running CSS animation of `doc` at its start; return the resume function. */
export const pauseLiveAnimationsAtStart = (doc: Document): (() => void) => {
    const all: Animation[] = typeof doc.getAnimations === 'function' ? doc.getAnimations() : [];
    const paused: Array<{ animation: Animation; time: CSSNumberish | null }> = [];
    all.forEach((animation) => {
        if (typeof CSSAnimation !== 'undefined' && !(animation instanceof CSSAnimation)) return;
        if (animation.playState !== 'running') return;
        paused.push({ animation, time: animation.currentTime });
        animation.pause();
        animation.currentTime = 0;
    });
    return () => {
        paused.forEach(({ animation, time }) => {
            animation.currentTime = time;
            animation.play();
        });
    };
};

/** Stop every animation and transition in the document html2canvas renders. */
export const freezeAnimationsInClone = (clonedDoc: Document): void => {
    const style = clonedDoc.createElement('style');
    style.setAttribute('data-logserv-export', 'freeze-animations');
    style.textContent =
        '*, *::before, *::after { animation: none !important; transition: none !important; }';
    (clonedDoc.head || clonedDoc.documentElement).appendChild(style);
};
