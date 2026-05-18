import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

/**
 * Modal that confronts an admin who is about to save the AI Assistant
 * Settings page with `audit_forwarder_enabled = false`. They must tick
 * the acknowledgement checkbox and click Submit before the save
 * proceeds; clicking Cancel aborts the save and reverts the dirty
 * state.
 *
 * The body of the disclaimer is intentionally serious in tone — this
 * is a tamper-resistance posture decision, not a routine setting.
 *
 * The exact disclaimer text is hashed (SHA-256) and stored on the
 * resulting `forwarder_disabled_acceptance` audit event as
 * `disclaimerHash`, so future audit reviews can prove which revision
 * of the wording the admin acknowledged.
 *
 * Build 98 / session 022.
 */

// The exact disclaimer text shown to the admin. Edits here MUST be
// considered a new revision — `disclaimerHash` on existing audit
// events will no longer match the wording the admin sees today, and
// any compliance review needs to know that's intentional.
export const ACCEPTANCE_DISCLAIMER_TEXT = `Audit log forwarding is currently disabled. While disabled, the AI Assistant audit log resides only on this Splunk instance. An administrator with shell access to the host running Splunkd can stop the daemon and modify or remove indexed events directly, without that action being independently recorded.

By submitting this acknowledgement you confirm:

  * You will not edit, delete, modify, alter, redact, omit, fabricate, or otherwise tamper with the ai_assistant_audit index, its bucket files on disk, or any audit event record at any time, by any means, on any host.

  * You understand that disabling audit forwarding does not relieve any compliance, regulatory, contractual, or fiduciary obligation you or your organisation may have to maintain tamper-evident audit records.

  * You understand that this acknowledgement is recorded against your administrator account, your network address, and a precise timestamp, and that this record is itself an audit event subject to the same integrity expectations as the records it concerns.

  * You understand that any subsequent inconsistency between local audit state and any independent record (offline backup, snapshot, third-party log, witness account) may be attributed to you personally.

If you are not comfortable accepting these terms, cancel this dialog and enable audit log forwarding to a destination outside the control of this instance's administrators.`;

// ─── styled primitives ────────────────────────────────────────────────────

const Backdrop = styled.div`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
`;

const Dialog = styled.div`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid #dc4e41;
    border-left: 4px solid #dc4e41;
    border-radius: 4px;
    max-width: 720px;
    width: 100%;
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    color: ${logservTheme.colors.textActive};
    font-family: inherit;
`;

const Header = styled.div`
    padding: 20px 24px 12px 24px;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    display: flex;
    align-items: center;
    gap: 14px;
`;

const SeverityBadge = styled.span`
    background: #dc4e41;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 3px;
    text-transform: uppercase;
`;

const Title = styled.h2`
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: ${logservTheme.colors.textActive};
`;

const Body = styled.div`
    padding: 16px 24px;
    overflow-y: auto;
    flex: 1;
    font-size: 13px;
    line-height: 1.55;
    color: ${logservTheme.colors.textDefault};
    & pre {
        font-family: inherit;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0 0 14px 0;
        font-size: 13px;
        line-height: 1.55;
    }
`;

const AckRow = styled.label`
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 14px 0 6px 0;
    padding: 12px 14px;
    background: rgba(220, 78, 65, 0.08);
    border: 1px solid #dc4e41;
    border-radius: 3px;
    font-size: 13px;
    font-weight: 500;
    color: ${logservTheme.colors.textActive};
    cursor: pointer;
    & input[type="checkbox"] {
        margin-top: 3px;
        flex-shrink: 0;
        transform: scale(1.15);
    }
`;

const Identity = styled.div`
    margin-top: 6px;
    padding: 10px 14px;
    background: ${logservTheme.colors.pageBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: 3px;
    font-size: 12px;
    color: ${logservTheme.colors.textMuted};
    & code {
        background: rgba(255, 255, 255, 0.04);
        padding: 1px 5px;
        border-radius: 2px;
        font-size: 11px;
        color: ${logservTheme.colors.textActive};
    }
`;

const Footer = styled.div`
    padding: 14px 24px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    display: flex;
    justify-content: flex-end;
    gap: 10px;
`;

const Button = styled.button<{ $variant?: 'submit' | 'cancel' }>`
    background: ${(p) => (p.$variant === 'submit' ? '#dc4e41' : 'transparent')};
    color: ${(p) => (p.$variant === 'submit' ? '#fff' : logservTheme.colors.textActive)};
    border: 1px solid ${(p) => (p.$variant === 'submit' ? '#dc4e41' : logservTheme.colors.panelBorderWeak)};
    border-radius: 3px;
    padding: 8px 18px;
    font-size: 13px;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    &:hover:not(:disabled) {
        filter: brightness(1.1);
    }
`;

// ─── helper: SHA-256 of the disclaimer text ───────────────────────────────

const sha256Hex = async (text: string): Promise<string> => {
    try {
        const enc = new TextEncoder().encode(text);
        const buf = await crypto.subtle.digest('SHA-256', enc);
        return Array.from(new Uint8Array(buf))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    } catch (_e) {
        return 'unavailable';
    }
};

// ─── component ────────────────────────────────────────────────────────────

/** Admin's binary answer to the T&C prompt. Both yes and no are
 *  first-class — per Splunk's optInVersion pattern, ANY interaction
 *  bumps the acknowledged version, and the choice is recorded
 *  separately. */
export type OptInChoice = 'yes' | 'no';

interface AcceptanceModalProps {
    /** Whether the modal is shown. */
    open: boolean;
    /** The admin's Splunk username — surfaced in the dialog so the
     *  admin sees exactly which account is being recorded. */
    adminUsername: string;
    /** Was forwarding ENABLED before this save attempt? Used in the
     *  audit event's `previousEnabledState`. */
    previousEnabledState: boolean;
    /** The current `optInVersion` declared in `default/ai_assistant_acks.conf
     *  [logserv-ai-assistant-tc]`. Surfaced in the dialog so admins
     *  see which revision of the disclaimer they're acknowledging. */
    tcVersion: number;
    /** Called when the admin makes a yes/no choice. Receives the
     *  binary answer and the SHA-256 of the disclaimer text the
     *  admin saw, so the caller can record both via the standard
     *  Splunk telemetry endpoint AND the audit log. Per Splunk's
     *  pattern this fires for BOTH yes (Submit) and no (Cancel) —
     *  the version is bumped either way; only the choice differs. */
    onChoice: (choice: OptInChoice, disclaimerHash: string) => Promise<void> | void;
    /** When true, both buttons show a busy state and are disabled
     *  (e.g. while the conf write + audit event post). */
    busy?: boolean;
}

const ForwarderDisabledAcceptanceModal: React.FC<AcceptanceModalProps> = ({
    open,
    adminUsername,
    previousEnabledState,
    tcVersion,
    onChoice,
    busy = false,
}) => {
    const [accepted, setAccepted] = useState<boolean>(false);
    const [hashing, setHashing] = useState<boolean>(false);

    // Reset the checkbox whenever the modal re-opens — we don't want a
    // stale tick to allow a save without a fresh acknowledgement.
    useEffect(() => {
        if (open) setAccepted(false);
    }, [open]);

    if (!open) return null;

    const fireChoice = async (choice: OptInChoice): Promise<void> => {
        setHashing(true);
        try {
            const hash = await sha256Hex(ACCEPTANCE_DISCLAIMER_TEXT);
            await onChoice(choice, hash);
        } finally {
            setHashing(false);
        }
    };

    const submitting = busy || hashing;
    const transitionLabel = previousEnabledState
        ? 'You are about to DISABLE audit log forwarding.'
        : 'Audit log forwarding is not enabled.';

    return (
        <Backdrop role="dialog" aria-modal="true" aria-labelledby="ack-title">
            <Dialog>
                <Header>
                    <SeverityBadge>Required acknowledgement v{tcVersion}</SeverityBadge>
                    <Title id="ack-title">Audit log integrity</Title>
                </Header>
                <Body>
                    <p style={{ marginTop: 0, fontWeight: 600, color: '#ff7a6b' }}>
                        {transitionLabel}
                    </p>
                    <pre>{ACCEPTANCE_DISCLAIMER_TEXT}</pre>
                    <Identity>
                        Your response (yes <em>or</em> no) and acknowledgement
                        of disclaimer version <code>v{tcVersion}</code> will be
                        recorded for administrator account{' '}
                        <code>{adminUsername || 'unknown'}</code> along with
                        your network address and a timestamp via the standard
                        Splunk telemetry endpoint.
                    </Identity>
                    <AckRow>
                        <input
                            type="checkbox"
                            checked={accepted}
                            onChange={(e) => setAccepted(e.target.checked)}
                            disabled={submitting}
                        />
                        I have read the above and accept full responsibility for
                        the integrity of the audit log on this Splunk instance.
                    </AckRow>
                </Body>
                <Footer>
                    <Button
                        type="button"
                        $variant="cancel"
                        onClick={() => fireChoice('no')}
                        disabled={submitting}
                    >
                        I do not accept (record No)
                    </Button>
                    <Button
                        type="button"
                        $variant="submit"
                        onClick={() => fireChoice('yes')}
                        disabled={!accepted || submitting}
                    >
                        {submitting ? 'Recording…' : 'I accept (record Yes and save)'}
                    </Button>
                </Footer>
            </Dialog>
        </Backdrop>
    );
};

export default ForwarderDisabledAcceptanceModal;
