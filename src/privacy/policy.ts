/**
 * What the agent is allowed to ask for.
 *
 * Redaction (see `redact.ts`) cleans values on the way out. This module is the
 * other half: it refuses certain *questions* outright, before a request is
 * spent, and it resolves the property identifier that users get wrong more
 * often than anything else in GA4.
 */

/**
 * Dimensions that link a row to a specific identified person. Blocked unless
 * explicitly allowed.
 *
 * The list is deliberately short. The alternative design — prompting for
 * approval on every URL-bearing dimension — was rejected: `pagePath` is in the
 * single most common question anyone asks ("what are my top pages?"), and a
 * tool that interrupts the most common question is a tool people stop using.
 * Value redaction runs unconditionally on every row of every report instead,
 * which is where the actual leaked identifiers live.
 */
const USER_IDENTIFYING_EXACT = new Set(["userId", "signedInWithUserId"]);

/**
 * User-scoped custom dimensions: the field teams reach for when they want to
 * join analytics back to a person, so in practice these hold CRM ids, account
 * ids and hashed emails.
 */
const USER_IDENTIFYING_PREFIXES = ["customUser:"];

/**
 * Dimensions whose values are visitor-authored, URL-derived, or hand-written
 * by marketers. Not blocked — they are the useful ones — but they are why
 * redaction is on by default and why results are marked as untrusted network
 * content: a stranger can put text in any of them by visiting a URL.
 */
const FREE_TEXT_PREFIXES = ["customEvent:", "customItem:", "sessionCustomChannelGroup:"];
const FREE_TEXT_EXACT = new Set([
  "pagePath",
  "pagePathPlusQueryString",
  "pageLocation",
  "fullPageUrl",
  "pageTitle",
  "pageReferrer",
  "landingPage",
  "landingPagePlusQueryString",
  "unifiedPagePathScreen",
  "unifiedPageScreen",
  "unifiedScreenName",
  "unifiedScreenClass",
  "hostName",
  "linkUrl",
  "linkText",
  "linkDomain",
  "fileName",
  "searchTerm",
  "manualTerm",
  "sessionManualTerm",
  "sessionManualAdContent",
  "googleAdsKeyword",
  "campaignName",
  "sessionCampaignName",
  "firstUserCampaignName",
  "transactionId",
  "orderCoupon",
  "itemName",
]);

/**
 * Dimensions Google's own thresholding exists to protect. Allowed, because
 * marketers legitimately report on them, but a report using one always carries
 * the thresholding caveat — small cohorts may be silently withheld.
 */
export const THRESHOLD_PRONE_DIMENSIONS: readonly string[] = [
  "userAgeBracket",
  "userGender",
  "brandingInterest",
  "audienceId",
  "audienceName",
  "audienceResourceName",
];

export type DimensionClass = "user-identifying" | "free-text" | "ordinary";

/**
 * @param userScopedCustom Dimension names the property reports as user-scoped
 *   custom definitions. Supplying these from a live `getMetadata` response
 *   means custom dimensions added to a property *after* this plugin shipped are
 *   still classified correctly, with no plugin update.
 */
export function classifyDimension(
  name: string,
  userScopedCustom: ReadonlySet<string> = new Set(),
): DimensionClass {
  if (
    USER_IDENTIFYING_EXACT.has(name) ||
    USER_IDENTIFYING_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    userScopedCustom.has(name)
  ) {
    return "user-identifying";
  }
  if (FREE_TEXT_EXACT.has(name) || FREE_TEXT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "free-text";
  }
  return "ordinary";
}

/** Dimensions in this request that make Google's thresholding likely. */
export function thresholdProneDimensions(dimensions: readonly string[]): string[] {
  return dimensions.filter((name) => THRESHOLD_PRONE_DIMENSIONS.includes(name));
}

export type AccessPolicy = {
  /** Permit `userId` and user-scoped custom dimensions. Off by default. */
  allowUserIdentifyingDimensions: boolean;
  /** When non-empty, only these numeric property ids may be queried. */
  propertyAllowlist: readonly string[];
};

export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  allowUserIdentifyingDimensions: false,
  propertyAllowlist: [],
};

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Refuse a query that asks for person-level dimensions, naming the opt-in. */
export function assertDimensionsAllowed(
  dimensions: readonly string[],
  policy: AccessPolicy,
  userScopedCustom: ReadonlySet<string> = new Set(),
): void {
  if (policy.allowUserIdentifyingDimensions) {
    return;
  }
  const blocked = dimensions.filter(
    (name) => classifyDimension(name, userScopedCustom) === "user-identifying",
  );
  if (blocked.length === 0) {
    return;
  }
  throw new PolicyError(
    `${blocked.join(", ")} ${blocked.length === 1 ? "identifies" : "identify"} individual people, ` +
      `so this plugin does not request ${blocked.length === 1 ? "it" : "them"} by default. ` +
      `To allow ${blocked.length === 1 ? "it" : "them"}, set ` +
      `plugins.entries.ga4.config.privacy.allowUserIdentifyingDimensions to true. ` +
      `For counts of people, use the totalUsers or activeUsers metric instead — ` +
      `it answers "how many" without naming anyone.`,
  );
}

export function assertPropertyAllowed(propertyId: string, policy: AccessPolicy): void {
  if (policy.propertyAllowlist.length === 0) {
    return;
  }
  if (!policy.propertyAllowlist.includes(propertyId)) {
    throw new PolicyError(
      `Property ${propertyId} is not in this plugin's allowlist ` +
        `(${policy.propertyAllowlist.join(", ")}). Add it to ` +
        `plugins.entries.ga4.config.privacy.propertyAllowlist to query it.`,
    );
  }
}

const MEASUREMENT_ID = /^G-[A-Z0-9]+$/i;
const STREAM_OR_TAG_ID = /^(?:GT|AW|DC)-[A-Z0-9]+$/i;
const NUMERIC_ID = /^\d{6,}$/;

/**
 * Turn whatever the user pasted into a bare numeric property id.
 *
 * The measurement id (`G-XXXXXXX`) is the string people see most often — it is
 * in the tag on their site — and it is *not* the property id the API wants.
 * Getting this wrong produces an opaque 403, so it is worth its own message.
 */
export function normalizePropertyId(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new PolicyError(
      "No GA4 property id. Run ga4_properties to list the properties this credential can read.",
    );
  }

  const withoutPrefix = value.replace(/^properties\//, "");

  if (NUMERIC_ID.test(withoutPrefix)) {
    return withoutPrefix;
  }

  if (MEASUREMENT_ID.test(value)) {
    throw new PolicyError(
      `"${value}" is a measurement id, which identifies a data stream rather than a property, ` +
        `and the reporting API cannot use it. You need the numeric property id — the ~9-digit ` +
        `number shown under Admin > Property details, or in the URL as p123456789. ` +
        `Run ga4_properties to list yours.`,
    );
  }

  if (STREAM_OR_TAG_ID.test(value)) {
    throw new PolicyError(
      `"${value}" is a Google tag or Ads id, not a GA4 property id. ` +
        `Run ga4_properties to list the numeric property ids this credential can read.`,
    );
  }

  throw new PolicyError(
    `"${value}" is not a GA4 property id. Expected a numeric id such as 123456789. ` +
      `Run ga4_properties to list the properties this credential can read.`,
  );
}
