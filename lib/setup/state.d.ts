import type { Check } from "../tools/discovery.js";
/**
 * `doctor --json`'s machine-readable state.
 *
 * The markdown checklist runDiagnose renders is right for a person reading a
 * terminal: it lists everything that is wrong. It is wrong for an agent
 * guiding somebody through setup, because the useful question at that point
 * is not "what is wrong" but "what do I do next". This module answers the
 * second question, and answers it with exactly one step: a person handed
 * five simultaneous problems does nothing, a person handed one does it.
 */
export type BlockedOn = "ok" | "no_credentials" | "bad_credentials" | "clock_skew" | "data_api_disabled" | "admin_api_disabled" | "no_property_grant" | "no_property_selected" | "wrong_property" | "quota" | "unknown";
export declare const BLOCKED_ON_VALUES: readonly BlockedOn[];
export type SetupState = {
    ok: boolean;
    blocked_on: BlockedOn;
    /** The service-account address currently in use, when one is known. */
    principal?: string;
    next?: {
        where: string;
        action: string;
        paste?: string;
        role?: string;
    };
    url?: string;
    properties?: Array<{
        id: string;
        name: string;
    }>;
};
/**
 * Reduces the checks runDiagnose produced to the single step that would
 * unblock setup, in dependency order.
 *
 * Two checks never reach `mapped`, on purpose:
 *
 * - A check with no `code` at all (the privacy-settings check, which is not
 *   error-driven) is outside this taxonomy entirely: it is a standing
 *   posture, not a reason a report cannot run, so it is not treated as
 *   blocking.
 * - ADMIN_API_DISABLED is skipped when the "data_api_report" check
 *   specifically passed later: that is the one check that actually proves
 *   reports work. Matching on *any* later check passing is wrong: runDiagnose
 *   always appends a "privacy_settings" check after it, and that check
 *   passes on essentially every real run (redaction is on by default), which
 *   would satisfy an "any later pass" predicate whether or not reports ever
 *   ran at all. That would hide the one genuine blocking step and send
 *   someone in a loop: told to run `properties` to fix "no property
 *   selected", which fails with the same ADMIN_API_DISABLED. Matched on
 *   `id`, a stable identifier, rather than `label`, which is display text
 *   somebody will reword.
 */
export declare function setupStateFrom(checks: Check[], principal?: string): SetupState;
