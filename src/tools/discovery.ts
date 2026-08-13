import { Type } from "typebox";
import type { FieldMetadata } from "../ga4/client.js";
import { diagnose } from "../ga4/errors.js";
import { RENAMED_FIELDS } from "../ga4/limits.js";
import { classifyDimension } from "../privacy/policy.js";
import type { Ga4Runtime } from "../runtime.js";

/**
 * The tools that answer "what can I even ask for": `ga4_fields` and
 * `ga4_diagnose`.
 *
 * Both read from the property itself rather than from a shipped list, so a
 * custom dimension added last week shows up without a plugin update.
 */

function scoreMatch(field: FieldMetadata, needle: string): number {
  const api = (field.apiName ?? "").toLowerCase();
  const ui = (field.uiName ?? "").toLowerCase();
  const description = (field.description ?? "").toLowerCase();

  if (api === needle || ui === needle) return 100;
  if (api.startsWith(needle) || ui.startsWith(needle)) return 80;
  if (api.includes(needle) || ui.includes(needle)) return 60;
  if (description.includes(needle)) return 30;
  return 0;
}

export function fieldsTool(runtime: Ga4Runtime) {
  return {
    name: "ga4_fields",
    label: "GA4 field search",
    description:
      "Search the dimensions and metrics a Google Analytics 4 property actually supports.\n\n" +
      "Use this before ga4_query whenever you are unsure of an exact API name — guessing costs a " +
      "failed request. Reads the property's live metadata, so it includes the custom dimensions " +
      "and metrics defined on that specific property, not just the standard ones.\n\n" +
      "Returns the API name to use, the name shown in the Google Analytics interface, and what " +
      "the field means.",
    promptSnippet: "ga4_fields — find the exact Google Analytics dimension or metric name for an idea.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "What you are looking for, in plain words — for example 'revenue', 'landing page', " +
          "'bounce', 'campaign'.",
      }),
      kind: Type.Optional(
        Type.Union([Type.Literal("any"), Type.Literal("dimension"), Type.Literal("metric")], {
          description:
            "Dimensions describe rows (a page, a country); metrics are the numbers. Defaults to any.",
        }),
      ),
      property_id: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(params: {
      query: string;
      kind?: "any" | "dimension" | "metric";
      property_id?: string;
      limit?: number;
    }, signal?: AbortSignal) {
      const propertyId = runtime.resolveProperty(params.property_id);
      const needle = params.query.trim().toLowerCase();
      const limit = params.limit ?? 15;
      const kind = params.kind ?? "any";

      const metadata = await runtime.metadata(propertyId, signal);

      const pool: Array<{ field: FieldMetadata; kind: "dimension" | "metric" }> = [
        ...(kind !== "metric" ? (metadata.dimensions ?? []).map((f) => ({ field: f, kind: "dimension" as const })) : []),
        ...(kind !== "dimension" ? (metadata.metrics ?? []).map((f) => ({ field: f, kind: "metric" as const })) : []),
      ];

      const matches = pool
        .map((entry) => ({ ...entry, score: scoreMatch(entry.field, needle) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || (a.field.apiName ?? "").localeCompare(b.field.apiName ?? ""))
        .slice(0, limit);

      const rename = RENAMED_FIELDS[params.query.trim()];

      const lines = [
        `## Fields matching "${params.query}"`,
        "",
        ...(rename
          ? [`Google renamed \`${params.query.trim()}\` to \`${rename}\`. Use \`${rename}\`.`, ""]
          : []),
      ];

      if (matches.length === 0) {
        lines.push(
          `No dimension or metric on property ${propertyId} matches that. Try a broader word — ` +
            `'page', 'user', 'session', 'revenue', 'source', 'event'.`,
        );
      } else {
        lines.push(
          "| API name | Shown in GA4 as | Kind | Meaning |",
          "| --- | --- | --- | --- |",
          ...matches.map((entry) => {
            const api = entry.field.apiName ?? "";
            const flags: string[] = [];
            if (entry.field.customDefinition) {
              flags.push("custom");
            }
            if (entry.kind === "dimension" && classifyDimension(api) === "user-identifying") {
              flags.push("blocked by default");
            }
            const kindCell = flags.length > 0 ? `${entry.kind} (${flags.join(", ")})` : entry.kind;
            const meaning = (entry.field.description ?? "").replace(/\s+/g, " ").slice(0, 140);
            return `| \`${api}\` | ${entry.field.uiName ?? ""} | ${kindCell} | ${meaning} |`;
          }),
        );
      }

      return {
        markdown: lines.join("\n"),
        details: {
          propertyId,
          query: params.query,
          matches: matches.map((entry) => ({
            apiName: entry.field.apiName,
            uiName: entry.field.uiName,
            kind: entry.kind,
            custom: entry.field.customDefinition === true,
          })),
        },
      };
    },
  };
}

type Check = {
  label: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  fix?: string;
};

function renderChecks(checks: Check[], extra: string[]): string {
  const symbol = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;
  const lines = ["## GA4 setup check", ""];
  for (const check of checks) {
    lines.push(`- **${symbol[check.status]}** ${check.label} — ${check.detail}`);
    if (check.fix) {
      lines.push(`    - Fix: ${check.fix}`);
    }
  }
  if (extra.length > 0) {
    lines.push("", ...extra);
  }
  return lines.join("\n");
}

export function diagnoseTool(runtime: Ga4Runtime) {
  return {
    name: "ga4_diagnose",
    label: "GA4 diagnostics",
    description:
      "Check the Google Analytics setup step by step and report exactly what is wrong and how to " +
      "fix it, and list the properties this credential can read.\n\n" +
      "Run this first if any other GA4 tool fails, or when the user does not know their property " +
      "id. It checks credentials, both required Google APIs, property access and a live query, " +
      "and stops at the first thing that is broken rather than reporting a cascade.",
    promptSnippet:
      "ga4_diagnose — check the Google Analytics setup and list reachable properties.",
    parameters: Type.Object({
      property_id: Type.Optional(
        Type.String({ description: "Property to test against. Defaults to the configured one." }),
      ),
    }),
    async execute(params: { property_id?: string }, signal?: AbortSignal) {
      const checks: Check[] = [];
      const extra: string[] = [];
      const properties: Array<{ id: string; name: string; account: string }> = [];

      // 1. Credentials.
      let client;
      try {
        client = await runtime.client();
        const probes = runtime.probes();
        const used = probes.find((probe) => probe.status === "used");
        checks.push({
          label: "Google credentials",
          status: "pass",
          detail: `loaded from ${used?.label ?? "an unknown source"}${
            runtime.principal() ? `, service account ${runtime.principal()}` : ""
          }`,
        });
      } catch (error) {
        const named = diagnose(error, { principal: runtime.principal() });
        checks.push({
          label: "Google credentials",
          status: "fail",
          detail: named.message,
          fix: named.fix,
        });
        return { markdown: renderChecks(checks, extra), details: { ok: false, checks } };
      }

      // 2. Admin API and property discovery, in one step: listing properties is
      //    both the check and the thing people most often need.
      try {
        const summaries = await client.listAccountSummaries(signal);
        for (const account of summaries) {
          for (const property of account.propertySummaries ?? []) {
            const id = (property.property ?? "").replace(/^properties\//, "");
            if (id) {
              properties.push({
                id,
                name: property.displayName ?? "(unnamed)",
                account: account.displayName ?? "(unnamed account)",
              });
            }
          }
        }
        checks.push({
          label: "Admin API and property access",
          status: "pass",
          detail: `${properties.length} propert${properties.length === 1 ? "y" : "ies"} reachable`,
        });
      } catch (error) {
        const named = diagnose(error, { principal: runtime.principal() });
        checks.push({
          label: "Admin API and property access",
          status: "fail",
          detail: named.message,
          fix: named.fix,
        });
      }

      // 3. A real report, which is the only thing that proves the Data API works.
      let propertyId: string | undefined;
      try {
        propertyId = runtime.resolveProperty(params.property_id ?? properties[0]?.id);
      } catch (error) {
        const named = diagnose(error);
        checks.push({
          label: "Property selection",
          status: "fail",
          detail: named.message,
          fix: named.fix,
        });
      }

      if (propertyId) {
        try {
          const response = await client.runReport(
            propertyId,
            {
              metrics: [{ name: "activeUsers" }],
              dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
              limit: "1",
            },
            signal,
          );
          const users = response.rows?.[0]?.metricValues?.[0]?.value ?? "0";
          checks.push({
            label: "Data API report",
            status: "pass",
            detail: `property ${propertyId} returned ${users} active users over the last 7 days`,
          });
          if (users === "0") {
            extra.push(
              "The query worked but returned zero users. That is a real answer, not an error — " +
                "check the property is the one receiving traffic, and that the date range is after " +
                "the property started collecting.",
            );
          }
        } catch (error) {
          const named = diagnose(error, { principal: runtime.principal(), propertyId });
          checks.push({
            label: "Data API report",
            status: "fail",
            detail: named.message,
            fix: named.fix,
          });
        }
      }

      // 4. Privacy posture, so it is visible rather than assumed.
      const { redaction, access } = runtime.config;
      checks.push({
        label: "Privacy settings",
        status: redaction.enabled ? "pass" : "fail",
        detail: redaction.enabled
          ? `redaction on; user-identifying dimensions ${
              access.allowUserIdentifyingDimensions ? "allowed" : "blocked"
            }; property allowlist ${
              access.propertyAllowlist.length > 0 ? access.propertyAllowlist.join(", ") : "not set"
            }`
          : "redaction is turned OFF, so personal data in URLs will reach the model",
        fix: redaction.enabled
          ? undefined
          : "Remove plugins.entries.ga4.config.privacy.redact, or set it to true.",
      });

      if (properties.length > 0) {
        extra.push(
          "",
          "**Properties this credential can read**",
          "",
          "| Property id | Name | Account |",
          "| --- | --- | --- |",
          ...properties.map((p) => `| \`${p.id}\` | ${p.name} | ${p.account} |`),
        );
      }

      const ok = checks.every((check) => check.status !== "fail");
      return {
        markdown: renderChecks(checks, extra),
        details: { ok, checks, properties },
      };
    },
  };
}
