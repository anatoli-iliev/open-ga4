import { resolveCredentials, type CredentialProbe } from "./auth/credentials.js";
import { createTokenProvider } from "./auth/token.js";
import { createGa4Client, type FieldMetadata, type Ga4Client, type MetadataResponse } from "./ga4/client.js";
import { Ga4Error } from "./ga4/errors.js";
import type { FetchLike } from "./ga4/http.js";
import { createAuditLogger, NULL_AUDIT_LOGGER, type AuditLogger } from "./privacy/audit.js";
import { assertPropertyAllowed, normalizePropertyId } from "./privacy/policy.js";
import type { ResolvedConfig } from "./config.js";

/**
 * Lazily assembled per-process state.
 *
 * Nothing here runs at plugin load. Credentials are read the first time a tool
 * actually needs them, so installing the plugin does not touch a key file, and
 * an OpenClaw instance that never asks an analytics question never opens one.
 */

export type Ga4Runtime = {
  config: ResolvedConfig;
  /** Opt-in local record of what was asked. Never records what came back. */
  audit: AuditLogger;
  client(): Promise<Ga4Client>;
  /** The service-account address, for "grant access to X" messages. */
  principal(): string | undefined;
  probes(): CredentialProbe[];
  resolveProperty(explicit?: string): string;
  metadata(propertyId: string, signal?: AbortSignal): Promise<MetadataResponse>;
  /** Dimension names this property reports as user-scoped custom definitions. */
  userScopedCustomDimensions(propertyId: string, signal?: AbortSignal): Promise<Set<string>>;
};

export type RuntimeOptions = {
  config: ResolvedConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  onWarning?: (message: string) => void;
};

export function createRuntime(options: RuntimeOptions): Ga4Runtime {
  const { config } = options;

  let clientPromise: Promise<Ga4Client> | undefined;
  let principalAddress: string | undefined;
  let lastProbes: CredentialProbe[] = [];
  const metadataCache = new Map<string, Promise<MetadataResponse>>();
  const audit = config.auditLogPath
    ? createAuditLogger({ path: config.auditLogPath, onError: options.onWarning })
    : NULL_AUDIT_LOGGER;

  async function build(): Promise<Ga4Client> {
    const resolution = await resolveCredentials({
      env: options.env,
    });
    lastProbes = resolution.probes;

    if (!resolution.ok) {
      const checked = resolution.probes
        .map((probe) => `  - ${probe.label}: ${probe.status}${probe.detail ? ` (${probe.detail})` : ""}`)
        .join("\n");
      throw new Ga4Error(
        "CREDENTIALS_MISSING",
        `No Google credentials found. Locations checked:\n${checked}`,
        "Save your service-account key as GA4_CREDENTIALS: paste the file's contents, or give " +
          "its path. Run `doctor` for a step-by-step check of what is still missing.",
      );
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

    client(): Promise<Ga4Client> {
      // Retry on the next call if construction failed, rather than caching a
      // rejected promise for the life of the process.
      if (!clientPromise) {
        clientPromise = build().catch((error: unknown) => {
          clientPromise = undefined;
          throw error;
        });
      }
      return clientPromise;
    },

    principal(): string | undefined {
      return principalAddress;
    },

    probes(): CredentialProbe[] {
      return lastProbes;
    },

    resolveProperty(explicit?: string): string {
      const candidate = explicit ?? config.defaultPropertyId;
      if (!candidate) {
        throw new Ga4Error(
          "NO_PROPERTY",
          "No GA4 property specified, and no default is configured.",
          "Pass property_id, or set the GA4_PROPERTY_ID environment variable. " +
            "Run ga4_diagnose to list the properties this credential can read.",
        );
      }
      const propertyId = normalizePropertyId(candidate);
      assertPropertyAllowed(propertyId, config.access);
      return propertyId;
    },

    async metadata(propertyId: string, signal?: AbortSignal): Promise<MetadataResponse> {
      let cached = metadataCache.get(propertyId);
      if (!cached) {
        cached = this.client()
          .then((client) => client.getMetadata(propertyId, signal))
          .catch((error: unknown) => {
            metadataCache.delete(propertyId);
            throw error;
          });
        metadataCache.set(propertyId, cached);
      }
      return cached;
    },

    async userScopedCustomDimensions(propertyId: string, signal?: AbortSignal): Promise<Set<string>> {
      try {
        const meta = await this.metadata(propertyId, signal);
        return new Set(
          (meta.dimensions ?? [])
            .filter((dimension: FieldMetadata) => dimension.customDefinition === true)
            .filter((dimension) => (dimension.apiName ?? "").startsWith("customUser:"))
            .map((dimension) => dimension.apiName ?? ""),
        );
      } catch {
        // Metadata is an optimisation for classification, not a gate. The
        // hardcoded rules in policy.ts still apply if this call fails.
        return new Set();
      }
    },
  };
}
