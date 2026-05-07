export type {
    AuditCategory,
    AuditEventBase,
    LocalOnlyEvent,
    VendorTier1Event,
    VendorTier2Event,
    SecurityBlockedSplEvent,
    RateLimitedPromptEvent,
    VendorTier2ElevationEvent,
    UserPromptJailbreakFlagEvent,
    SessionToolCapHitEvent,
    DailySpendCapHitEvent,
    ForwarderDisabledAcceptanceEvent,
    AuditForwarderFailureEvent,
    AiAssistantEnableAcceptanceEvent,
    AuditEvent,
} from './auditTypes';

export type { AuditWriterOptions, AuditForwarderConfig } from './auditWriter';
export {
    AuditWriter,
    setAuditForwarderConfig,
    getAuditForwarderConfig,
    setLocalAuditIndex,
    getLocalAuditIndex,
} from './auditWriter';
