/**
 * What the agent is allowed to ask for.
 *
 * Redaction (see `redact.ts`) cleans values on the way out. This module is the
 * other half: it refuses certain *questions* outright, before a request is
 * spent, and it resolves the property identifier that users get wrong more
 * often than anything else in GA4.
 */
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
export declare class PolicyError extends Error {
    constructor(message: string);
}
/** Refuse a query that asks for person-level dimensions, naming the opt-in. */
export declare function assertDimensionsAllowed(dimensions: readonly string[], policy: AccessPolicy, userScopedCustom?: ReadonlySet<string>): void;
export declare function assertPropertyAllowed(propertyId: string, policy: AccessPolicy): void;
/**
 * Turn whatever the user pasted into a bare numeric property id.
 *
 * The measurement id (`G-XXXXXXX`) is the string people see most often (it is
 * in the tag on their site), and it is *not* the property id the API wants.
 * Getting this wrong produces an opaque 403, so it is worth its own message.
 */
export declare function normalizePropertyId(input: string): string;
