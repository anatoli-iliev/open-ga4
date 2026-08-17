import { resolveCredentials } from "./auth/credentials.js";
import { createTokenProvider } from "./auth/token.js";
import { createGa4Client } from "./ga4/client.js";
import { Ga4Error } from "./ga4/errors.js";
import { createAuditLogger, NULL_AUDIT_LOGGER } from "./privacy/audit.js";
import { assertPropertyAllowed, normalizePropertyId } from "./privacy/policy.js";
export function createRuntime(options) {
    const { config } = options;
    let clientPromise;
    let principalAddress;
    let lastProbes = [];
    const metadataCache = new Map();
    const audit = config.auditLogPath
        ? createAuditLogger({ path: config.auditLogPath, onError: options.onWarning })
        : NULL_AUDIT_LOGGER;
    async function build() {
        const resolution = await resolveCredentials({
            env: options.env,
        });
        lastProbes = resolution.probes;
        if (!resolution.ok) {
            const checked = resolution.probes
                .map((probe) => `  - ${probe.label}: ${probe.status}${probe.detail ? ` (${probe.detail})` : ""}`)
                .join("\n");
            throw new Ga4Error("CREDENTIALS_MISSING", `No Google credentials found. Locations checked:\n${checked}`, "Save your service-account key as GA4_CREDENTIALS: paste the file's contents, or give " +
                "its path. Run `doctor` for a step-by-step check of what is still missing.");
        }
        if (resolution.credential.kind === "service_account") {
            principalAddress = resolution.credential.account.clientEmail;
        }
        const tokens = createTokenProvider(resolution.credential, { fetchImpl: options.fetchImpl });
        return createGa4Client({
            getAccessToken: (signal) => tokens.getAccessToken(signal),
            fetchImpl: options.fetchImpl,
        });
    }
    return {
        config,
        audit,
        client() {
            // Retry on the next call if construction failed, rather than caching a
            // rejected promise for the life of the process.
            if (!clientPromise) {
                clientPromise = build().catch((error) => {
                    clientPromise = undefined;
                    throw error;
                });
            }
            return clientPromise;
        },
        principal() {
            return principalAddress;
        },
        probes() {
            return lastProbes;
        },
        resolveProperty(explicit) {
            const candidate = explicit ?? config.defaultPropertyId;
            if (!candidate) {
                throw new Ga4Error("NO_PROPERTY", "No GA4 property specified, and no default is configured.", "Pass --property, or set the GA4_PROPERTY_ID environment variable. " +
                    "Run properties to list the ones this credential can read.");
            }
            const propertyId = normalizePropertyId(candidate);
            assertPropertyAllowed(propertyId, config.access);
            return propertyId;
        },
        async metadata(propertyId, signal) {
            let cached = metadataCache.get(propertyId);
            if (!cached) {
                cached = this.client()
                    .then((client) => client.getMetadata(propertyId, signal))
                    .catch((error) => {
                    metadataCache.delete(propertyId);
                    throw error;
                });
                metadataCache.set(propertyId, cached);
            }
            return cached;
        },
        async userScopedCustomDimensions(propertyId, signal) {
            try {
                const meta = await this.metadata(propertyId, signal);
                return new Set((meta.dimensions ?? [])
                    .filter((dimension) => dimension.customDefinition === true)
                    .filter((dimension) => (dimension.apiName ?? "").startsWith("customUser:"))
                    .map((dimension) => dimension.apiName ?? ""));
            }
            catch {
                // Metadata is an optimisation for classification, not a gate. The
                // hardcoded rules in policy.ts still apply if this call fails.
                return new Set();
            }
        },
    };
}
