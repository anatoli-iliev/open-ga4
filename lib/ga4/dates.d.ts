/**
 * Date range parsing.
 *
 * A GA4 property reports in *its own* timezone, which is frequently not the
 * timezone of the machine running OpenClaw. Computing "yesterday" locally and
 * sending an absolute date is how integrations end up quietly off by one day.
 *
 * The API accepts relative tokens (`today`, `yesterday`, `NdaysAgo`) and
 * resolves them in the property's timezone. So the rule here is: emit a
 * relative token whenever the request is relative, and fall back to absolute
 * dates only for calendar boundaries ("last month") that have no token form.
 * Those carry an explicit note about which timezone was used.
 */
export type Ga4DateRange = {
    /** `YYYY-MM-DD`, `NdaysAgo`, `yesterday`, or `today`. */
    startDate: string;
    endDate: string;
    /** Human label for the rendered report header. */
    label: string;
    /** Set when boundaries were computed locally rather than resolved by Google. */
    timezoneNote?: string;
};
export declare class DateRangeError extends Error {
    constructor(input: string);
}
/**
 * Parse a human date-range expression into GA4 request fields.
 *
 * @param today Reference date. Injected so tests do not depend on the clock.
 */
export declare function parseDateRange(input: string, today?: Date): Ga4DateRange;
/**
 * Build the immediately preceding range of equal length, for period comparison.
 *
 * Resolves relative tokens to absolute dates first, because "the 7 days before
 * the last 7 days" has no relative-token spelling.
 */
export declare function precedingRange(range: Ga4DateRange, today?: Date): Ga4DateRange;
/** Turn any accepted GA4 date expression into a concrete UTC date. */
export declare function resolveToDate(value: string, today?: Date): Date;
