/**
 * Optional local audit log.
 *
 * Off unless `privacy.auditLogPath` is set. When on, it records what was
 * *asked*, never what came back. A log that contained report rows would be
 * exactly the personal data this skill works to keep off disk, so response
 * bodies, row values and totals never reach it.
 *
 * This is the only module in the skill that writes to a file, which is what
 * makes the "nothing is written to disk" claim checkable: `surface.test.ts`
 * asserts no other shipped module calls a write API.
 */
export type AuditEntry = {
    tool: string;
    propertyId: string;
    dimensions?: readonly string[];
    metrics?: readonly string[];
    dateRange?: string;
    /** How many rows came back. A count, never a value. */
    rows?: number;
};
export type AuditLogger = {
    record(entry: AuditEntry): Promise<void>;
};
/** A logger that does nothing, used when no path is configured. */
export declare const NULL_AUDIT_LOGGER: AuditLogger;
export type AuditLoggerOptions = {
    path: string;
    now?: () => Date;
    /** Injected for tests. */
    append?: (path: string, line: string) => Promise<void>;
    onError?: (message: string) => void;
};
export declare function createAuditLogger(options: AuditLoggerOptions): AuditLogger;
