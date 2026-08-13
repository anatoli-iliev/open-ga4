import { Type, type Static } from "typebox";
import { DEFAULT_KEPT_QUERY_PARAMS, type RedactionOptions } from "./privacy/redact.js";
import { DEFAULT_ACCESS_POLICY, type AccessPolicy } from "./privacy/policy.js";
import { LIMITS } from "./ga4/limits.js";

/**
 * Plugin configuration, as it appears under
 * `plugins.entries.ga4.config` in `openclaw.json`.
 *
 * Everything is optional. With no configuration at all the plugin still works
 * if `GOOGLE_APPLICATION_CREDENTIALS` is set or gcloud application-default
 * credentials exist, which is the common case for anyone who has used another
 * Google tool on this machine.
 */
export const configSchema = Type.Object(
  {
    credentials: Type.Optional(
      Type.String({
        description:
          "Path to a Google service-account JSON key file. Falls back to " +
          "GOOGLE_APPLICATION_CREDENTIALS, then to gcloud application-default credentials.",
      }),
    ),
    propertyId: Type.Optional(
      Type.String({
        description:
          "Default GA4 property id — the numeric one, not the G-XXXXXXX measurement id. " +
          "Tools take a property_id argument that overrides this.",
      }),
    ),
    defaultRowLimit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LIMITS.MAX_ROWS,
        description: `Rows returned when a tool does not specify. Defaults to ${LIMITS.DEFAULT_ROWS}.`,
      }),
    ),
    privacy: Type.Optional(
      Type.Object(
        {
          redact: Type.Optional(
            Type.Boolean({
              description:
                "Mask emails, tokens, ids and unsafe query-parameter values in dimension " +
                "values before the model sees them. On by default. Turning this off is not " +
                "recommended.",
            }),
          ),
          keepQueryParams: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Query-parameter names whose values survive redaction. Defaults to the common " +
                "marketing and search parameters.",
            }),
          ),
          extraRedactionPatterns: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Additional regular expressions to mask, for identifiers specific to your site " +
                "(for example an employee or order reference format).",
            }),
          ),
          allowUserIdentifyingDimensions: Type.Optional(
            Type.Boolean({
              description:
                "Permit dimensions that identify individual people (userId, customUser:*). " +
                "Off by default.",
            }),
          ),
          propertyAllowlist: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "When set, only these property ids may be queried. Empty means no restriction.",
            }),
          ),
          auditLogPath: Type.Optional(
            Type.String({
              description:
                "Append a line per API call (time, property, tool, fields) to this file. " +
                "Off by default. Never records response data.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Ga4PluginConfig = Static<typeof configSchema>;

export type ResolvedConfig = {
  credentialsPath?: string;
  defaultPropertyId?: string;
  defaultRowLimit: number;
  redaction: RedactionOptions;
  access: AccessPolicy;
  auditLogPath?: string;
};

/**
 * Turn raw config into the shapes the rest of the plugin uses.
 *
 * Invalid user-supplied regular expressions are dropped with a warning rather
 * than crashing the plugin: a typo in an optional privacy pattern should not
 * take analytics offline.
 */
export function resolveConfig(
  raw: Ga4PluginConfig | undefined,
  onWarning?: (message: string) => void,
): ResolvedConfig {
  const privacy = raw?.privacy ?? {};

  const extraPatterns: RegExp[] = [];
  for (const source of privacy.extraRedactionPatterns ?? []) {
    try {
      extraPatterns.push(new RegExp(source, "g"));
    } catch (error) {
      onWarning?.(
        `Ignoring privacy.extraRedactionPatterns entry ${JSON.stringify(source)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    credentialsPath: raw?.credentials,
    defaultPropertyId: raw?.propertyId,
    defaultRowLimit: raw?.defaultRowLimit ?? LIMITS.DEFAULT_ROWS,
    redaction: {
      enabled: privacy.redact ?? true,
      keepQueryParams: privacy.keepQueryParams ?? DEFAULT_KEPT_QUERY_PARAMS,
      extraPatterns,
    },
    access: {
      ...DEFAULT_ACCESS_POLICY,
      allowUserIdentifyingDimensions: privacy.allowUserIdentifyingDimensions ?? false,
      propertyAllowlist: privacy.propertyAllowlist ?? [],
    },
    auditLogPath: privacy.auditLogPath,
  };
}
