import React, { useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import { PrivacyPosture, AIProvider, ModelDescriptor } from '../providers/AIProvider';
import DocsHelpIcon from '../../DocsHelpIcon';
import { DOCS_AI_ASSISTANT_OVERVIEW } from '../../../utils/docsLinks';

/**
 * PrivacyBanner — persistent display of the user's actual outbound
 * posture per the active provider. Per design §2.4, this is a
 * trust-anchor surface: the user can always see what their session is
 * exposing.
 *
 * Click → AuditModal lists every audit event with its category badge:
 *   🟢 Local-only (canned prompts, no outbound)
 *   🟡 Vendor Tier 1 (free-form questions, no event data)
 *   🟠 Vendor Tier 2 (aggregated metadata, opt-in)
 *
 * Per design §6.5, "Local-only" is shown prominently because it's
 * usually the most common category — a strong privacy signal.
 */

interface PrivacyBannerProps {
    provider: AIProvider;
    tier: 0 | 1 | 2;
    /** Number of local-only audit events this session. */
    localOnlyCount: number;
    /** Number of Tier-1 vendor audit events this session. */
    tier1Count: number;
    /** Number of Tier-2 vendor audit events this session. */
    tier2Count: number;
    /** Called when the user clicks "Audit this session". */
    onOpenAudit?: () => void;
    /** Currently-active model id. When provided alongside `onModelChange`,
     *  renders an inline `<select>` in the banner so the user can switch
     *  models mid-session. */
    selectedModel?: string;
    /** Setter invoked when the user picks a different model. */
    onModelChange?: (id: string) => void;
    /** Runtime templates-only mode. When true, the model picker is
     *  hidden (no LLM dispatch, so no model to choose). Replaces the
     *  prior compile-time TEMPLATES_ONLY build flag. */
    templatesOnlyMode?: boolean;
}

const Banner = styled.div<{ $tier: 0 | 1 | 2 }>`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.md};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    background: ${logservTheme.colors.tableHeaderBackground};
    border-bottom: 1px solid
        ${(p) =>
            p.$tier === 2
                ? logservTheme.colors.orange
                : logservTheme.colors.panelBorder};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.small};
    flex-wrap: wrap;
`;

const Lock = styled.span`
    font-size: ${logservTheme.fontSize.body};
`;

const TierLabel = styled.span<{ $tier: 0 | 1 | 2 }>`
    color: ${(p) =>
        p.$tier === 2
            ? logservTheme.colors.orange
            : logservTheme.colors.cyanLight};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const Posture = styled.span`
    color: ${logservTheme.colors.textMuted};
`;

const Counter = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-feature-settings: 'tnum' 1;
`;

const AuditButton = styled.button`
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.cyanLight};
    padding: 2px 10px;
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.small};

    &:hover { color: ${logservTheme.colors.textActive}; border-color: ${logservTheme.colors.cyanAccent}; }
`;

const ModelPickerWrap = styled.label`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-left: auto;
`;

const ModelSelect = styled.select`
    background: ${logservTheme.colors.panelBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: 2px;
    padding: 2px 6px;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.small};
    cursor: pointer;

    &:hover { border-color: ${logservTheme.colors.cyanAccent}; }
    &:focus { outline: 1px solid ${logservTheme.colors.cyanAccent}; outline-offset: 1px; }
`;

const RightCluster = styled.div`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    margin-left: auto;
`;

const formatPosture = (p: PrivacyPosture): string => {
    const parts: string[] = [];
    parts.push(p.noTraining ? 'No training' : 'Training: enabled');
    parts.push(p.zeroRetention ? 'No retention' : `${p.abuseLoggingDays}d abuse logging`);
    return parts.join(', ');
};

const PrivacyBanner: React.FC<PrivacyBannerProps> = ({
    provider,
    tier,
    localOnlyCount,
    tier1Count,
    tier2Count,
    onOpenAudit,
    selectedModel,
    onModelChange,
    templatesOnlyMode = false,
}) => {
    // Templates-only mode hides the model picker — the model is
    // irrelevant when no LLM call is ever made; surfacing it would be
    // confusing.
    const showPicker =
        !templatesOnlyMode &&
        typeof selectedModel === 'string' &&
        typeof onModelChange === 'function' &&
        provider.models.length > 1;

    return (
        <Banner $tier={tier}>
            <Lock>{tier === 2 ? '⚠️' : '🔒'}</Lock>
            <TierLabel $tier={tier}>
                {tier === 0 && 'Tier 0 — Air-gapped local'}
                {tier === 1 && 'Tier 1 — Cloud (queries only)'}
                {tier === 2 && 'Tier 2 — Cloud + aggregated metadata'}
            </TierLabel>
            <Posture>
                {provider.label}
                {tier !== 0 && ` — ${formatPosture(provider.privacyPosture)}`}
            </Posture>
            <Counter>
                🟢 {localOnlyCount} local-only · 🟡 {tier1Count} vendor T1 · 🟠 {tier2Count} vendor T2
            </Counter>
            <RightCluster>
                {showPicker && (
                    <ModelPickerWrap>
                        Model:
                        <ModelSelect
                            value={selectedModel}
                            onChange={(e) => onModelChange!(e.target.value)}
                            aria-label="AI model"
                        >
                            {provider.models.map((m: ModelDescriptor) => (
                                <option key={m.id} value={m.id}>
                                    {m.label}
                                </option>
                            ))}
                        </ModelSelect>
                    </ModelPickerWrap>
                )}
                {onOpenAudit && (
                    <AuditButton type="button" onClick={onOpenAudit}>
                        Audit this session
                    </AuditButton>
                )}
                <DocsHelpIcon
                    href={DOCS_AI_ASSISTANT_OVERVIEW}
                    title="Open AI Assistant documentation in a new tab"
                    size={26}
                />
            </RightCluster>
        </Banner>
    );
};

export default PrivacyBanner;

// -----------------------------------------------------------------------------
// AuditModal — companion modal that lists every audit event in this session.
// -----------------------------------------------------------------------------

import { AuditEvent } from '../audit/auditTypes';

const Overlay = styled.div`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 9000;
    display: flex;
    align-items: center;
    justify-content: center;
`;

const Box = styled.div`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.medium};
    padding: ${logservTheme.spacing.lg};
    width: 720px;
    max-height: 80vh;
    overflow-y: auto;
    color: ${logservTheme.colors.textActive};
`;

const ModalHeader = styled.div`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: ${logservTheme.spacing.md};
    margin-bottom: ${logservTheme.spacing.lg};
`;

const ModalTitle = styled.h3`
    margin: 0;
    font-size: ${logservTheme.fontSize.xlarge};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const CategoryHeader = styled.h4<{ $color: string }>`
    margin: ${logservTheme.spacing.lg} 0 ${logservTheme.spacing.sm} 0;
    font-size: ${logservTheme.fontSize.body};
    color: ${(p) => p.$color};
`;

const EventRow = styled.div`
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: ${logservTheme.spacing.sm};
    margin-bottom: ${logservTheme.spacing.xs};
    font-size: ${logservTheme.fontSize.small};

    & code {
        font-family: monospace;
        background: rgba(0,0,0,0.3);
        padding: 1px 4px;
        border-radius: 2px;
    }
`;

const EmptyCategory = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-style: italic;
    font-size: ${logservTheme.fontSize.small};
    padding: ${logservTheme.spacing.sm} 0;
`;

const CloseBtn = styled.button`
    background: transparent;
    border: 0;
    color: ${logservTheme.colors.textMuted};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.large};
    padding: 4px 8px;
    font-family: inherit;

    &:hover { color: ${logservTheme.colors.textActive}; }
`;

interface AuditModalProps {
    events: ReadonlyArray<AuditEvent>;
    onClose: () => void;
}

export const AuditModal: React.FC<AuditModalProps> = ({ events, onClose }) => {
    const local = events.filter((e) => e.category === 'local_only');
    const t1 = events.filter((e) => e.category === 'vendor_tier1');
    const t2 = events.filter((e) => e.category === 'vendor_tier2');
    const blocked = events.filter((e) => e.category === 'security_blocked_spl');
    const rateLimited = events.filter((e) => e.category === 'rate_limited_prompt');
    const jailbreakFlagged = events.filter((e) => e.category === 'user_prompt_jailbreak_flag');
    const sessionCapHit = events.filter((e) => e.category === 'session_tool_cap_hit');
    const spendCapHit = events.filter((e) => e.category === 'daily_spend_cap_hit');

    return (
        <Overlay onClick={onClose}>
            <Box onClick={(e) => e.stopPropagation()}>
                <ModalHeader>
                    <ModalTitle>Session audit</ModalTitle>
                    <CloseBtn type="button" onClick={onClose} aria-label="Close">
                        ✕
                    </CloseBtn>
                </ModalHeader>

                <CategoryHeader $color={logservTheme.colors.teal}>
                    🟢 Local-only ({local.length})
                </CategoryHeader>
                {local.length === 0 ? (
                    <EmptyCategory>No canned-prompt executions in this session.</EmptyCategory>
                ) : (
                    local.map((e) => (
                        <EventRow key={`${e.sessionId}-${e.seq}`}>
                            <code>{(e as { promptId?: string }).promptId ?? 'unknown'}</code> · {(e as { rowCount?: number }).rowCount ?? 0} rows · {(e as { executionMs?: number }).executionMs ?? 0}ms
                        </EventRow>
                    ))
                )}

                <CategoryHeader $color={logservTheme.colors.yellow}>
                    🟡 Vendor — Tier 1 ({t1.length})
                </CategoryHeader>
                {t1.length === 0 ? (
                    <EmptyCategory>No outbound-vendor calls in this session.</EmptyCategory>
                ) : (
                    t1.map((e) => {
                        const v = e as { provider?: string; model?: string; outboundBytes?: number; promptLength?: number; inputTokens?: number; outputTokens?: number; vendorCostEstimateUsd?: number; turnCount?: number };
                        const tokens = (v.inputTokens ?? 0) + (v.outputTokens ?? 0);
                        const cost = v.vendorCostEstimateUsd ?? 0;
                        return (
                            <EventRow key={`${e.sessionId}-${e.seq}`}>
                                <code>{v.provider}</code> / <code>{v.model}</code> · {v.outboundBytes}b out · prompt {v.promptLength}c · {v.turnCount ?? 0} turns · {tokens} tok ({v.inputTokens ?? 0} in / {v.outputTokens ?? 0} out) · ${cost.toFixed(4)}
                            </EventRow>
                        );
                    })
                )}

                <CategoryHeader $color={logservTheme.colors.orange}>
                    🟠 Vendor — Tier 2 ({t2.length})
                </CategoryHeader>
                {t2.length === 0 ? (
                    <EmptyCategory>No Tier-2 elevations in this session.</EmptyCategory>
                ) : (
                    t2.map((e) => {
                        const v = e as { provider?: string; aggregateKind?: string; userApproved?: boolean };
                        return (
                            <EventRow key={`${e.sessionId}-${e.seq}`}>
                                <code>{v.provider}</code> · {v.aggregateKind} · {v.userApproved ? 'approved' : 'auto'}
                            </EventRow>
                        );
                    })
                )}

                <CategoryHeader $color={logservTheme.colors.red}>
                    🔴 Security — Blocked SPL ({blocked.length})
                </CategoryHeader>
                {blocked.length === 0 ? (
                    <EmptyCategory>No SPL guard rejections in this session.</EmptyCategory>
                ) : (
                    blocked.map((e) => {
                        const v = e as { operator?: string; spl?: string };
                        return (
                            <EventRow key={`${e.sessionId}-${e.seq}`}>
                                operator <code>{v.operator}</code> · <code>{(v.spl ?? '').slice(0, 80)}{(v.spl ?? '').length > 80 ? '…' : ''}</code>
                            </EventRow>
                        );
                    })
                )}

                <CategoryHeader $color={logservTheme.colors.red}>
                    🔴 Security — Rate Limited ({rateLimited.length})
                </CategoryHeader>
                {rateLimited.length === 0 ? (
                    <EmptyCategory>No rate-limit refusals in this session.</EmptyCategory>
                ) : (
                    rateLimited.map((e) => {
                        const v = e as { threshold?: number; countInWindow?: number; secondsUntilNextSlot?: number; promptLength?: number };
                        return (
                            <EventRow key={`${e.sessionId}-${e.seq}`}>
                                {v.countInWindow}/{v.threshold} in window · prompt {v.promptLength}c · next slot in {v.secondsUntilNextSlot}s
                            </EventRow>
                        );
                    })
                )}

                <CategoryHeader $color={logservTheme.colors.orange}>
                    🟠 Security — Jailbreak Patterns Flagged ({jailbreakFlagged.length})
                </CategoryHeader>
                {jailbreakFlagged.length === 0 ? (
                    <EmptyCategory>No jailbreak-pattern matches in this session.</EmptyCategory>
                ) : (
                    jailbreakFlagged.map((e) => {
                        const v = e as { matchedGroups?: string[]; promptLength?: number; charClassFingerprint?: { alpha?: number; digit?: number; other?: number }; promptHash?: string };
                        const groups = (v.matchedGroups || []).join(', ') || 'unknown';
                        const cc = v.charClassFingerprint || {};
                        const hashShort = (v.promptHash || '').slice(0, 8);
                        return (
                            <EventRow key={`${e.sessionId}-${e.seq}`}>
                                groups <code>{groups}</code> · prompt {v.promptLength}c · alpha {cc.alpha ?? 0}% / other {cc.other ?? 0}% · sha256 <code>{hashShort}…</code>
                            </EventRow>
                        );
                    })
                )}

                <CategoryHeader $color={logservTheme.colors.red}>
                    🔴 Security — Session Tool Cap Hit ({sessionCapHit.length})
                </CategoryHeader>
                {sessionCapHit.length === 0 ? (
                    <EmptyCategory>No session-tool-cap refusals in this session.</EmptyCategory>
                ) : (
                    sessionCapHit.map((e) => {
                        const v = e as { cap?: number; attemptedCount?: number; toolName?: string };
                        return (
                            <EventRow key={`${e.sessionId}-${e.seq}`}>
                                cap {v.cap} · attempted {v.attemptedCount} · refused tool <code>{v.toolName}</code>
                            </EventRow>
                        );
                    })
                )}

                <CategoryHeader $color={logservTheme.colors.red}>
                    🔴 Security — Daily Spend Cap Hit ({spendCapHit.length})
                </CategoryHeader>
                {spendCapHit.length === 0 ? (
                    <EmptyCategory>No daily-spend-cap refusals in this session.</EmptyCategory>
                ) : (
                    spendCapHit.map((e) => {
                        const v = e as { capUsd?: number; spentTodayUsd?: number; promptLength?: number; secondsUntilMidnight?: number };
                        const hours = Math.ceil((v.secondsUntilMidnight ?? 0) / 3600);
                        return (
                            <EventRow key={`${e.sessionId}-${e.seq}`}>
                                spent ${(v.spentTodayUsd ?? 0).toFixed(4)} of ${(v.capUsd ?? 0).toFixed(2)} cap · prompt {v.promptLength}c · resets in ~{hours}h
                            </EventRow>
                        );
                    })
                )}
            </Box>
        </Overlay>
    );
};
