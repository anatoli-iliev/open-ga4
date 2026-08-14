import { appendFile } from "node:fs/promises";

/**
 * Optional local audit log.
 *
 * Off unless `privacy.auditLogPath` is set. When on, it records what was
 * *asked*, never what came back. A log that contained report rows would be
 * exactly the personal data this plugin works to keep off disk, so response
 * bodies, row values and totals never reach it.
 *
 * This is the only module in the plugin that writes to a file, which is what
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
export const NULL_AUDIT_LOGGER: AuditLogger = {
  async record(): Promise<void> {
    // Intentionally empty.
  },
};

export type AuditLoggerOptions = {
  path: string;
  now?: () => Date;
  /** Injected for tests. */
  append?: (path: string, line: string) => Promise<void>;
  onError?: (message: string) => void;
};

export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  const now = options.now ?? (() => new Date());
  const append = options.append ?? ((path: string, line: string) => appendFile(path, line, "utf8"));

  return {
    async record(entry: AuditEntry): Promise<void> {
      const line =
        JSON.stringify({
          time: now().toISOString(),
          tool: entry.tool,
          property: entry.propertyId,
          ...(entry.dimensions?.length ? { dimensions: [...entry.dimensions] } : {}),
          ...(entry.metrics?.length ? { metrics: [...entry.metrics] } : {}),
          ...(entry.dateRange ? { dateRange: entry.dateRange } : {}),
          ...(entry.rows === undefined ? {} : { rows: entry.rows }),
        }) + "\n";

      try {
        await append(options.path, line);
      } catch (error) {
        // A failing audit log must not take analytics down. Report it once and
        // carry on: losing a log line is better than losing the answer.
        options.onError?.(
          `Could not append to the GA4 audit log at ${options.path}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
