import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../config.js";
import type { CredentialProbe } from "../auth/credentials.js";
import type { AccountSummary, Ga4Client, MetadataResponse, RunReportResponse } from "../ga4/client.js";
import { assertPropertyAllowed, normalizePropertyId } from "../privacy/policy.js";
import type { Ga4Runtime } from "../runtime.js";
import { runDiagnose, runFields, runProperties } from "./discovery.js";

type StubOptions = {
  envOverrides?: Parameters<typeof configFromEnv>[0];
  summaries?: AccountSummary[];
  summariesError?: Error;
  reportResponse?: RunReportResponse;
  metadata?: MetadataResponse;
  clientError?: Error;
  probes?: CredentialProbe[];
};

function stubRuntime(options: StubOptions = {}): { runtime: Ga4Runtime; client: Ga4Client } {
  const config = configFromEnv({ GA4_PROPERTY_ID: "123456789", ...options.envOverrides });

  const client = {
    listAccountSummaries: vi.fn(async () => {
      if (options.summariesError) {
        throw options.summariesError;
      }
      return options.summaries ?? [];
    }),
    runReport: vi.fn(async () => options.reportResponse ?? {}),
  } as unknown as Ga4Client;

  const runtime: Ga4Runtime = {
    config,
    audit: { record: async () => {} },
    client: async () => {
      if (options.clientError) {
        throw options.clientError;
      }
      return client;
    },
    principal: () => "reader@example.iam.gserviceaccount.com",
    probes: () => options.probes ?? [{ label: "GA4_CREDENTIALS", path: "env", status: "used" }],
    resolveProperty: (explicit?: string) => {
      const propertyId = normalizePropertyId(explicit ?? config.defaultPropertyId!);
      assertPropertyAllowed(propertyId, config.access);
      return propertyId;
    },
    metadata: async () => options.metadata ?? {},
    userScopedCustomDimensions: async () => new Set<string>(),
  };

  return { runtime, client };
}

const SUMMARIES: AccountSummary[] = [
  {
    displayName: "Acme Inc",
    propertySummaries: [
      { property: "properties/111222333", displayName: "Marketing site" },
      { property: "properties/444555666", displayName: "Docs site" },
    ],
  },
];

describe("runProperties", () => {
  it("lists every property this credential can read, stripping the properties/ prefix", async () => {
    const { runtime } = stubRuntime({ summaries: SUMMARIES });
    const result = await runProperties(runtime, {});
    expect(result.details).toEqual({
      properties: [
        { id: "111222333", name: "Marketing site", account: "Acme Inc" },
        { id: "444555666", name: "Docs site", account: "Acme Inc" },
      ],
    });
    expect(result.markdown).toContain("111222333");
    expect(result.markdown).toContain("Marketing site");
  });

  it("says plainly when no properties are reachable", async () => {
    const { runtime } = stubRuntime({ summaries: [] });
    const result = await runProperties(runtime, {});
    expect(result.markdown).toMatch(/No properties reachable/);
    expect(result.details).toEqual({ properties: [] });
  });

  it("propagates an Admin API failure rather than swallowing it", async () => {
    const { runtime } = stubRuntime({ summariesError: new Error("boom") });
    await expect(runProperties(runtime, {})).rejects.toThrow("boom");
  });
});

describe("runFields", () => {
  it("finds a dimension by a substring of its API name", async () => {
    const { runtime } = stubRuntime({
      metadata: {
        dimensions: [{ apiName: "pagePath", uiName: "Page path", description: "The URL path." }],
        metrics: [],
      },
    });
    const result = await runFields(runtime, { query: "page" });
    expect(result.markdown).toContain("pagePath");
  });

  it("flags a user-identifying dimension as blocked by default", async () => {
    const { runtime } = stubRuntime({
      metadata: { dimensions: [{ apiName: "userId", uiName: "User Id" }], metrics: [] },
    });
    const result = await runFields(runtime, { query: "user" });
    expect(result.markdown).toMatch(/blocked by default/);
  });

  it("restricts to metrics when kind is metric", async () => {
    const { runtime } = stubRuntime({
      metadata: {
        dimensions: [{ apiName: "sessionSource" }],
        metrics: [{ apiName: "sessions" }],
      },
    });
    const result = await runFields(runtime, { query: "session", kind: "metric" });
    expect(result.markdown).toContain("sessions");
    expect(result.markdown).not.toContain("sessionSource");
  });

  it("says when nothing on the property matches", async () => {
    const { runtime } = stubRuntime({ metadata: { dimensions: [], metrics: [] } });
    const result = await runFields(runtime, { query: "nonexistent" });
    expect(result.markdown).toMatch(/No dimension or metric/);
  });
});

describe("runDiagnose", () => {
  it("stops at credentials and never attempts property discovery", async () => {
    const { runtime, client } = stubRuntime({ clientError: new Error("no creds") });
    const result = await runDiagnose(runtime, {});
    expect((result.details as { ok: boolean }).ok).toBe(false);
    expect(result.markdown).toMatch(/Google credentials/);
    expect(client.listAccountSummaries).not.toHaveBeenCalled();
  });

  it("names which key file was used, for the stale-path case", async () => {
    const { runtime } = stubRuntime({
      summaries: SUMMARIES,
      probes: [{ label: "GA4_CREDENTIALS (file)", path: "/keys/sa.json", status: "used" }],
    });
    const result = await runDiagnose(runtime, {});
    expect(result.markdown).toContain("/keys/sa.json");
  });

  it("reuses runProperties for property discovery instead of listing them twice", async () => {
    const { runtime, client } = stubRuntime({ summaries: SUMMARIES });
    const result = await runDiagnose(runtime, {});
    expect(client.listAccountSummaries).toHaveBeenCalledTimes(1);
    expect((result.details as { properties: unknown[] }).properties).toHaveLength(2);
    expect(result.markdown).toMatch(/2 properties reachable/);
    expect(result.markdown).toMatch(/Properties this credential can read/);
  });

  it("marks property access as failed without aborting the rest of the checks", async () => {
    const { runtime } = stubRuntime({ summariesError: new Error("admin api disabled") });
    const result = await runDiagnose(runtime, { property_id: "123456789" });
    expect(result.markdown).toMatch(/\*\*FAIL\*\* Admin API and property access/);
    // A later check (privacy settings) still ran rather than the function returning early.
    expect(result.markdown).toMatch(/Privacy settings/);
  });

  it("reports overall ok only when every check passes", async () => {
    const { runtime } = stubRuntime({ summaries: SUMMARIES });
    const result = await runDiagnose(runtime, {});
    expect((result.details as { ok: boolean }).ok).toBe(true);
  });
});
