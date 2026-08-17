import { redactText } from "../privacy/redact.js";
import { EgressBlockedError, Ga4HttpError } from "./http.js";
/**
 * Turning Google's errors into next actions.
 *
 * Two rules hold throughout:
 *
 * 1. Discriminate on machine-readable fields (HTTP status, `error.status`,
 *    and `details[].reason`), never on `error.message` prose, which is
 *    unversioned and localized.
 * 2. Build messages from an allowlist of fields. Never serialize the caught
 *    error, which on some paths carries the Authorization header.
 */
export class Ga4Error extends Error {
    code;
    fix;
    retryable;
    constructor(code, message, 
    /** What the user should do next. Always present. */
    fix, retryable = false) {
        super(message);
        this.code = code;
        this.fix = fix;
        this.retryable = retryable;
        this.name = "Ga4Error";
    }
    /** The whole thing, as a model or a terminal should see it. */
    toString() {
        return `${this.message}\n\n${this.fix}`;
    }
}
function detailsOf(body) {
    const envelope = (body ?? {});
    const details = envelope.error?.details ?? [];
    const info = details.find((entry) => String(entry["@type"] ?? "").endsWith("google.rpc.ErrorInfo"));
    const help = details.find((entry) => String(entry["@type"] ?? "").endsWith("google.rpc.Help"));
    return { info, help, status: envelope.error?.status };
}
const SKEW_TOLERANCE_MS = 60_000;
/**
 * Map a transport failure onto a named cause and a fix.
 *
 * Order matters: clock skew is checked first, because it presents as a bare
 * `invalid_grant` that otherwise reads as a credential problem and sends
 * people off to regenerate perfectly good keys.
 */
export function diagnose(error, context = {}) {
    if (error instanceof Ga4Error) {
        return error;
    }
    // The egress guard refused to open the connection, so this is the one
    // failure here that Google never heard about. Named rather than left to the
    // UNEXPECTED bucket below, whose fix ("Run doctor to check the setup") is no
    // help for a host list compiled into the source. It exits 1, not 2: every
    // URL this skill builds comes from its own constants, so reaching this means
    // the skill tried to contact somewhere it is not allowed to, which is a
    // defect in the skill rather than anything the user typed. Mapped here
    // instead of by making EgressBlockedError a Ga4Error, because this module
    // already imports src/ga4/http.ts and the reverse import would be a cycle
    // evaluated at class-definition time (see the comment on that class).
    if (error instanceof EgressBlockedError) {
        return new Ga4Error("EGRESS_BLOCKED", redactText(error.message), "Nothing was sent. The permitted hosts are a constant in this skill's source, so no " +
            "setting would have allowed it. Please report this, naming the command that produced it.");
    }
    if (!(error instanceof Ga4HttpError)) {
        const message = error instanceof Error ? error.message : String(error);
        return new Ga4Error("UNEXPECTED", redactText(message), "Run doctor to check the setup.");
    }
    const now = context.now ?? Date.now;
    const { info, help, status } = detailsOf(error.body);
    const principal = context.principal ?? "this skill's Google credential";
    if (error.serverDate) {
        const skewMs = error.serverDate.getTime() - now();
        if (Math.abs(skewMs) > SKEW_TOLERANCE_MS) {
            const seconds = Math.round(Math.abs(skewMs) / 1000);
            const direction = skewMs > 0 ? "behind" : "ahead of";
            return new Ga4Error("CLOCK_SKEW", `This machine's clock is about ${seconds} seconds ${direction} Google's, which invalidates ` +
                `the signed token used to authenticate. Google reports ${error.serverDate.toISOString()}.`, "Turn on network time sync: `sudo timedatectl set-ntp true` on Linux, or Date & Time > " +
                "Set automatically on macOS and Windows, then try again. Your Analytics account and " +
                "credentials are fine.");
        }
    }
    if (error.status === 403 && info?.reason === "SERVICE_DISABLED") {
        const service = info.metadata?.service ?? "analyticsdata.googleapis.com";
        const project = info.metadata?.consumer?.replace(/^projects\//, "") ?? "your Google Cloud project";
        const link = help?.links?.[0]?.url ?? `https://console.cloud.google.com/apis/api/${service}/overview`;
        if (service === "analyticsadmin.googleapis.com") {
            return new Ga4Error("ADMIN_API_DISABLED", `The Google Analytics Admin API is not enabled in project ${project}. It is a separate API ` +
                `from the reporting one, so listing properties does not work yet even though reports do.`, `Enable it at ${link}, wait about a minute, then try again. In the meantime you can pass a ` +
                `numeric property id directly to any report tool.`);
        }
        return new Ga4Error("DATA_API_DISABLED", `The Google Analytics Data API is not enabled in project ${project}, so no reports can run yet.`, `Enable it at ${link}, wait about a minute for it to propagate, then try again.`);
    }
    if (error.status === 403) {
        const property = context.propertyId ? `property ${context.propertyId}` : "that property";
        return new Ga4Error("NO_PROPERTY_ACCESS", `${principal} cannot read ${property}. Google gives the same answer whether the property ` +
            `does not exist or the credential simply cannot see it, so it may be either.`, `In Google Analytics open Admin > Property access management, add ${principal}, and give it ` +
            `the Viewer role. Then run doctor to confirm what this credential can reach.`);
    }
    if (error.status === 404 || status === "NOT_FOUND") {
        return new Ga4Error("PROPERTY_NOT_FOUND", `Google Analytics has no property with id ${context.propertyId ?? "that id"}.`, "Run properties to list the ones this credential can reach, or find the id in " +
            "Google Analytics under Admin > Property details.");
    }
    if (error.status === 401 || status === "UNAUTHENTICATED") {
        if (info?.reason === "CREDENTIALS_MISSING") {
            return new Ga4Error("CREDENTIALS_MISSING", "The request reached Google without a usable credential.", "Run doctor. It reports every location this skill checked for credentials and what " +
                "it found in each.");
        }
        return new Ga4Error("CREDENTIALS_REJECTED", "Google rejected the credential.", "Tokens are refreshed automatically, so this usually means the service-account key was " +
            "revoked or deleted in Google Cloud. Generate a new key and put it in GA4_CREDENTIALS.");
    }
    if (error.status === 429 || status === "RESOURCE_EXHAUSTED") {
        return new Ga4Error("QUOTA_EXHAUSTED", "Google Analytics has run out of API quota for this property.", "Daily allowances reset at midnight US Pacific time and hourly ones within the hour. Fewer " +
            "dimensions, shorter date ranges and smaller row limits all cost less quota.", true);
    }
    if (error.status === 400) {
        return new Ga4Error("INVALID_REQUEST", "Google Analytics rejected the query as invalid.", "Run fields to see the dimensions and metrics this property actually has, including its " +
            "custom ones. Some combinations are also impossible because the fields are measured at " +
            "different scopes.");
    }
    if (error.status >= 500) {
        return new Ga4Error("GOOGLE_SERVER_ERROR", `Google Analytics returned a server error (HTTP ${error.status}). This is on Google's side, ` +
            `not a problem with the query.`, "Try again shortly. Repeated server errors also consume a separate hourly allowance, so this " +
            "skill stops retrying after a few attempts rather than locking the property out.", true);
    }
    return new Ga4Error("UNEXPECTED", `Google Analytics returned HTTP ${error.status}: ${redactText(error.message)}`, "Run doctor to check credentials, API enablement and property access.");
}
