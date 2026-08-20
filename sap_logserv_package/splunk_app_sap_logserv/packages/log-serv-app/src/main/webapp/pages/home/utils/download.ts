/**
 * download — the ONE proven browser-download mechanism (extracted from
 * `ActionsDropdown` in session 095 so the Data Doctor reports reuse it rather
 * than growing a second, subtly different copy).
 *
 * History that must not be lost: jsPDF 4.x's internal save()/FileSaver anchor
 * fails with Chrome's "Something went wrong" once the user picks a save
 * location under "ask where to save each file" (build 256) — every PDF/PNG/
 * report download goes through THIS helper with a blob instead.
 */

export const triggerDownload = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Free the object URL after a generous grace period. Chrome's
    // "ask where to save each file" setting defers the actual write until
    // the user picks a location — revoking too early makes the download
    // fail with "Something went wrong" AFTER the save dialog (build 256).
    // A few MB held for a minute is a fine trade for never racing the
    // user's save dialog.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
