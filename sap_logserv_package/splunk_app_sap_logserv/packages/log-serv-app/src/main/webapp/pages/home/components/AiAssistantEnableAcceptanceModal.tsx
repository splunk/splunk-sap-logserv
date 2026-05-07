import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

/**
 * Modal that confronts an admin who is about to save the AI Assistant
 * Settings page with `enabled = true` while the current
 * feature-enablement liability acknowledgement version (tracked in
 * `default/ai_assistant_acks.conf [logserv-ai-assistant-enable-tc]`) has not
 * yet been acknowledged on this deployment.
 *
 * Per Splunk's optInVersion pattern, ANY interaction with the modal
 * (yes via Submit OR no via Cancel) bumps the conf's
 * `optInVersionAcknowledged` to current. The boolean choice is
 * recorded separately in `optInChoice` and on the
 * `ai_assistant_enable_acceptance` audit event.
 *
 * Save behaviour:
 *   * yes  → save proceeds (enable AI Assistant)
 *   * no   → save aborted (`enabled` stays at its previous value)
 *
 * The exact disclaimer text is hashed (SHA-256) and stored on the
 * audit event as `disclaimerHash`. Bump `optInVersion` in
 * `default/ai_assistant_acks.conf [logserv-ai-assistant-enable-tc]` after any
 * change to `ENABLE_DISCLAIMER_TEXT` to force re-acknowledgement
 * across all admins.
 *
 * Build 100 / session 022.
 */

// ─────────────────────────────────────────────────────────────────────
// EXACT DISCLAIMER TEXT — v0.0.5.0 LLM-STRIPPED VARIANT
// ─────────────────────────────────────────────────────────────────────
//
// Aligned to publicly available Splunk Master Subscription Agreement
// (MSA) and Cisco End User License Agreement (EULA) language patterns.
// REWRITTEN for the v0.0.5.0 LLM-stripped variant: the original 7-clause
// disclaimer (build 100 / session 022) was heavy on LLM-provider data-
// egress language that does not apply to this build, where the LLM-
// driven flow is physically removed from source — there is no provider,
// no API key, no data egress, and no AI-generated output. The dropped
// material covered LLM-provider data egress (clause 1), LLM-provider
// selection / API key handling (clause 2), AI-output reliability
// language inside the warranty disclaimer (clause 3 partial), and LLM-
// provider-specific indemnification (clause 4 sub-points). What remains
// is: a feature-scope acknowledgement, customer responsibility for
// catalog selection and access control, AS-IS warranty, indemnification
// + limitation of liability (combined into one clause), authority, and
// record of acknowledgement.
//
// Edits are a NEW REVISION — bump `optInVersion` in
// `default/ai_assistant_acks.conf [logserv-ai-assistant-enable-tc]` whenever
// this constant changes; existing audit events' `disclaimerHash` values
// will no longer match the wording the admin sees today, which is the
// correct semantics for compliance review.
export const ENABLE_DISCLAIMER_TEXT = `LIABILITY ACKNOWLEDGEMENT — AI ASSISTANT ENABLEMENT

By enabling the LogServ AI Assistant feature on this Splunk deployment, you acknowledge and agree to the following on behalf of yourself and the entity that licenses this software ("Customer"):

1. WHAT THIS FEATURE PROVIDES.
This build of the LogServ App ships with the Large Language Model ("LLM")-driven flow physically removed from source. Enabling the feature exposes the AI Assistant chat panel and a curated catalog of predefined prompts that dispatch saved searches against Customer's Splunk indexes via the Splunk MCP Server. No external LLM provider is invoked, no event data is transmitted outside this Splunk deployment, and no AI-generated narrative is produced. Every prompt dispatch and every administrative action is recorded in the \`_ai_assistant_audit\` index.

2. CUSTOMER RESPONSIBILITY.
Customer is solely responsible for: (a) determining whether the predefined prompt catalog and the saved searches it dispatches are appropriate for Customer's environment, data classification, and compliance posture; (b) reviewing the audit-log forwarder configuration and the per-user controls exposed by this feature; (c) the role grants and search-time access controls that govern which users can dispatch prompts and view results; and (d) any operational, investigative, compliance, or decision-making consequences arising from Customer's use of the feature.

3. DISCLAIMER OF WARRANTIES.
THE AI ASSISTANT FEATURE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTY OF ANY KIND. WITHOUT LIMITING THE FOREGOING, SPLUNK INC. ("SPLUNK"), CISCO SYSTEMS, INC. ("CISCO"), AND THEIR RESPECTIVE AFFILIATES, LICENSORS, AND SUPPLIERS DISCLAIM ALL WARRANTIES, EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WITHOUT LIMITATION ANY IMPLIED WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NONINFRINGEMENT, ABSENCE OF ERRORS OR OMISSIONS, OR UNINTERRUPTED OPERATION. CUSTOMER MUST INDEPENDENTLY VERIFY ALL OUTPUT BEFORE RELYING UPON IT FOR ANY OPERATIONAL, INVESTIGATIVE, COMPLIANCE, OR DECISION-MAKING PURPOSE.

4. INDEMNIFICATION AND LIMITATION OF LIABILITY.
Customer agrees to defend, indemnify, and hold harmless Splunk, Cisco, and their respective affiliates, officers, directors, employees, agents, licensors, and suppliers (the "Indemnified Parties") from and against any and all claims, liabilities, damages, losses, costs, and expenses (including reasonable attorneys' fees and costs of investigation) arising out of or in any way connected with Customer's enablement, configuration, or use of the AI Assistant feature, or any breach by Customer of this acknowledgement or of Customer's master agreement with Splunk or Cisco. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE INDEMNIFIED PARTIES BE LIABLE TO CUSTOMER OR TO ANY THIRD PARTY FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES (INCLUDING WITHOUT LIMITATION DAMAGES FOR LOSS OF DATA, LOSS OF PROFITS, BUSINESS INTERRUPTION, REPUTATIONAL HARM, OR THIRD-PARTY CLAIMS) ARISING FROM OR RELATING TO CUSTOMER'S ENABLEMENT, CONFIGURATION, OR USE OF THE AI ASSISTANT FEATURE, REGARDLESS OF THE LEGAL OR EQUITABLE THEORY UPON WHICH ANY SUCH CLAIM MAY BE BASED, AND EVEN IF AN INDEMNIFIED PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. THE FOREGOING DISCLAIMERS APPLY IN ADDITION TO, AND DO NOT REPLACE, ANY LIMITATIONS OR DISCLAIMERS APPLICABLE UNDER CUSTOMER'S MASTER AGREEMENT WITH SPLUNK OR CISCO; WHERE A CONFLICT EXISTS, THE PROVISION MORE PROTECTIVE OF THE INDEMNIFIED PARTIES SHALL CONTROL.

5. AUTHORITY.
The administrator submitting this acknowledgement represents and warrants that they have the actual authority to bind Customer to the obligations set forth herein, and that they are submitting this acknowledgement of their own volition and not under duress, coercion, or mistake.

6. RECORD OF ACKNOWLEDGEMENT.
Customer's response to this acknowledgement (yes or no) is recorded together with the administrator's account name, network address, and a precise timestamp, and is durably retained as part of the AI Assistant audit log. This record is itself an audit event subject to the same integrity expectations as the records it concerns.

If Customer does not accept these terms, the administrator should select "I do not accept" below; the AI Assistant feature will remain disabled.`;

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
    border: 1px solid #f1813f;
    border-left: 4px solid #f1813f;
    border-radius: 4px;
    max-width: 760px;
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
    background: #f1813f;
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
    background: rgba(241, 129, 63, 0.08);
    border: 1px solid #f1813f;
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
    background: ${(p) => (p.$variant === 'submit' ? '#f1813f' : 'transparent')};
    color: ${(p) => (p.$variant === 'submit' ? '#fff' : logservTheme.colors.textActive)};
    border: 1px solid ${(p) => (p.$variant === 'submit' ? '#f1813f' : logservTheme.colors.panelBorderWeak)};
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

/** Admin's binary answer to the T&C prompt — same shape as the
 *  forwarder modal's `OptInChoice`. */
export type EnableOptInChoice = 'yes' | 'no';

interface EnableModalProps {
    /** Whether the modal is shown. */
    open: boolean;
    /** The admin's Splunk username — surfaced in the dialog so the
     *  admin sees exactly which account is being recorded. */
    adminUsername: string;
    /** The admin's currently-configured LLM provider name (e.g.
     *  'anthropic'). Surfaced in the body so the legal context is
     *  concrete for the deployment. */
    providerName: string;
    /** Was AI Assistant ENABLED before this save attempt? Used in the
     *  audit event's `previousEnabledState` and the dialog headline. */
    previousEnabledState: boolean;
    /** The current `optInVersion` declared in
     *  `default/ai_assistant_acks.conf [logserv-ai-assistant-enable-tc]`.
     *  Surfaced in the dialog so admins see which revision they're
     *  acknowledging. */
    tcVersion: number;
    /** Called when the admin makes a yes/no choice. Receives the
     *  binary answer and the SHA-256 of the disclaimer text the
     *  admin saw. Per Splunk's optInVersion pattern this fires for
     *  BOTH yes (Submit) and no (Cancel). */
    onChoice: (
        choice: EnableOptInChoice,
        disclaimerHash: string,
    ) => Promise<void> | void;
    /** When true, both buttons show a busy state and are disabled. */
    busy?: boolean;
}

const AiAssistantEnableAcceptanceModal: React.FC<EnableModalProps> = ({
    open,
    adminUsername,
    providerName,
    previousEnabledState,
    tcVersion,
    onChoice,
    busy = false,
}) => {
    const [accepted, setAccepted] = useState<boolean>(false);
    const [hashing, setHashing] = useState<boolean>(false);

    useEffect(() => {
        if (open) setAccepted(false);
    }, [open]);

    if (!open) return null;

    const fireChoice = async (choice: EnableOptInChoice): Promise<void> => {
        setHashing(true);
        try {
            const hash = await sha256Hex(ENABLE_DISCLAIMER_TEXT);
            await onChoice(choice, hash);
        } finally {
            setHashing(false);
        }
    };

    const submitting = busy || hashing;
    const transitionLabel = previousEnabledState
        ? 'Re-acknowledgement required for the AI Assistant feature.'
        : 'You are about to ENABLE the AI Assistant feature for this deployment.';

    return (
        <Backdrop role="dialog" aria-modal="true" aria-labelledby="enable-ack-title">
            <Dialog>
                <Header>
                    <SeverityBadge>Liability acknowledgement v{tcVersion}</SeverityBadge>
                    <Title id="enable-ack-title">AI Assistant — Liability terms</Title>
                </Header>
                <Body>
                    <p style={{ marginTop: 0, fontWeight: 600, color: '#f4a535' }}>
                        {transitionLabel}
                    </p>
                    <p style={{ color: logservTheme.colors.textMuted, marginTop: 0 }}>
                        Active LLM provider: <code>{providerName || '(none configured)'}</code>.
                        The disclaimer below applies regardless of which provider is configured;
                        Customer's choice of provider is governed by Customer's separate agreement
                        with that provider.
                    </p>
                    <pre>{ENABLE_DISCLAIMER_TEXT}</pre>
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
                        I have read the above legal terms in their entirety,
                        understand the liability disclaimers, and accept them
                        on behalf of myself and the Customer entity.
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
                        {submitting ? 'Recording…' : 'I accept (record Yes and enable)'}
                    </Button>
                </Footer>
            </Dialog>
        </Backdrop>
    );
};

export default AiAssistantEnableAcceptanceModal;
