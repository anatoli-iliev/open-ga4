import { Ga4Error } from "../ga4/errors.js";
/**
 * Dimensions Google's own thresholding exists to protect. Allowed, because
 * marketers legitimately report on them, but a report using one always carries
 * the thresholding caveat: small cohorts may be silently withheld.
 */
export declare const THRESHOLD_PRONE_DIMENSIONS: readonly string[];
export type DimensionClass = "user-identifying" | "free-text" | "ordinary";
/**
 * @param userScopedCustom Dimension names the property reports as user-scoped
 *   custom definitions. Supplying these from a live `getMetadata` response
 *   means custom dimensions added to a property *after* this skill shipped are
 *   still classified correctly, with no skill update.
 */
export declare function classifyDimension(name: string, userScopedCustom?: ReadonlySet<string>): DimensionClass;
/** Dimensions in this request that make Google's thresholding likely. */
export declare function thresholdProneDimensions(dimensions: readonly string[]): string[];
export type AccessPolicy = {
    /** Permit `userId` and user-scoped custom dimensions. Off by default. */
    allowUserIdentifyingDimensions: boolean;
    /** When non-empty, only these numeric property ids may be queried. */
    propertyAllowlist: readonly string[];
};
export declare const DEFAULT_ACCESS_POLICY: AccessPolicy;
/**
 * A refusal this skill made locally: a dimension it will not ask for, a
 * property outside the allowlist, an identifier that is not a property id.
 *
 * Extends Ga4Error, rather than a plain Error, for the same reason
 * Ga4RequestError in src/ga4/limits.ts does (read the comment there; this is
 * the same defect, found again in a second class that was not brought along
 * with the first). Anything that is not a Ga4Error falls through diagnose()
 * into the generic "UNEXPECTED" bucket, whose fix is "Run doctor to check the
 * setup" and whose exit code says Google refused the request. None of these
 * ever reach a socket: attributing this skill's own privacy refusal to Google
 * is both false and unfixable by the person who reads it.
 *
 * `code` is per-throw rather than fixed, because these are not all the same
 * kind of problem:
 *
 * - INVALID_REQUEST (exit 2) for a value the caller can correct: a blocked
 *   dimension, a property outside the allowlist, a string that is no kind of
 *   Google identifier at all.
 * - PROPERTY_NOT_FOUND (exit 3) for a measurement id or a Google tag/Ads id.
 *   Those identify something real in Google's world but not a property, and
 *   they are what people paste because it is the id on their own site. That
 *   code is what makes `doctor --json` report `blocked_on: "wrong_property"`,
 *   the setup step written for exactly this mistake, so the agent gets the
 *   conversation the state machine already has an answer for.
 * - NO_PROPERTY (exit 3) for a blank one, matching src/runtime.ts's own
 *   NO_PROPERTY when nothing was configured at all.
 */
export declare class PolicyError extends Ga4Error {
    constructor(message: string, options?: {
        code?: string;
        fix?: string;
    });
}
/**
 * Which channel carried a dimension name into the request.
 *
 * It changes nothing about the decision and everything about the explanation.
 * A name used only as a filter field or a sort key never appears as a column,
 * so a refusal that says no more than "this dimension identifies people" leaves
 * the reader with an obvious and wrong next move: drop it from the output
 * columns and ask again. That is exactly the request being refused. Filtering a
 * report down to one person's rows is a request for that person's data whatever
 * the columns are called, and the message has to say so, because it is the part
 * that is not self-evident.
 */
export type DimensionUse = "columns" | "filter" | "sort";
/**
 * Refuse a query that asks for person-level dimensions, naming the opt-in.
 *
 * Called on every channel a dimension name can travel through, not only the
 * output column list: see `buildFilters` and `buildOrderBys` in
 * src/ga4/filters.ts. A gate on the column list alone was bypassable, and in
 * the worst way, because the refusal it left in place made the skill look like
 * it was enforcing something it was not.
 */
export declare function assertDimensionsAllowed(dimensions: readonly string[], policy: AccessPolicy, userScopedCustom?: ReadonlySet<string>, use?: DimensionUse): void;
export declare function assertPropertyAllowed(propertyId: string, policy: AccessPolicy): void;
/**
 * Turn whatever the user pasted into a bare numeric property id.
 *
 * The measurement id (`G-XXXXXXX`) is the string people see most often (it is
 * in the tag on their site), and it is *not* the property id the API wants.
 * Getting this wrong produces an opaque 403, so it is worth its own message.
 */
export declare function normalizePropertyId(input: string): string;
