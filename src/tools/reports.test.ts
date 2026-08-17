import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../config.js";
import type { Ga4Client, RunReportRequest, RunReportResponse } from "../ga4/client.js";
import { assertPropertyAllowed, normalizePropertyId } from "../privacy/policy.js";
import type { Ga4Runtime } from "../runtime.js";
import { runCompare, runQuery, runRealtime, runReport } from "./reports.js";

type Recorded = { propertyId: string; request: RunReportRequest };

function stubRuntime(
  response: RunReportResponse = {},
  envOverrides: Parameters<typeof configFromEnv>[0] = {},
): { runtime: Ga4Runtime; calls: Recorded[]; realtimeCalls: Recorded[] } {
  const calls: Recorded[] = [];
  const realtimeCalls: Recorded[] = [];
  const config = configFromEnv({ GA4_PROPERTY_ID: "123456789", ...envOverrides });

  const client = {
    runReport: vi.fn(async (propertyId: string, request: RunReportRequest) => {
      calls.push({ propertyId, request });
      return response;
    }),
    runRealtimeReport: vi.fn(async (propertyId: string, request: RunReportRequest) => {
      realtimeCalls.push({ propertyId, request });
      return response;
    }),
  } as unknown as Ga4Client;

  const runtime: Ga4Runtime = {
    config,
    audit: { record: async () => {} },
    client: async () => client,
    principal: () => "reader@example.iam.gserviceaccount.com",
    probes: () => [],
    // Mirrors createRuntime().resolveProperty. runtime.test.ts covers the real
    // one; keeping this in step matters because a stub that skips a check
    // silently turns the test below into a test of the stub.
    resolveProperty: (explicit?: string) => {
      const propertyId = normalizePropertyId(explicit ?? config.defaultPropertyId!);
      assertPropertyAllowed(propertyId, config.access);
      return propertyId;
    },
    metadata: async () => ({}),
    userScopedCustomDimensions: async () => new Set<string>(),
  };

  return { runtime, calls, realtimeCalls };
}

const SAMPLE: RunReportResponse = {
  dimensionHeaders: [{ name: "pagePath" }],
  metricHeaders: [
    { name: "screenPageViews", type: "TYPE_INTEGER" },
    { name: "activeUsers", type: "TYPE_INTEGER" },
    { name: "userEngagementDuration", type: "TYPE_SECONDS" },
    { name: "keyEvents", type: "TYPE_INTEGER" },
  ],
  rows: [
    {
      dimensionValues: [{ value: "/pricing" }],
      metricValues: [{ value: "900" }, { value: "700" }, { value: "120" }, { value: "9" }],
    },
  ],
  rowCount: 1,
};

describe("the report command", () => {
  it("expands a preset into verified field names", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runReport(runtime, { report: "top_pages" });

    expect(calls[0]!.request.dimensions).toEqual([{ name: "pagePath" }]);
    expect(calls[0]!.request.metrics?.map((m) => m.name)).toEqual([
      "screenPageViews",
      "activeUsers",
      "userEngagementDuration",
      "keyEvents",
    ]);
  });

  it("defaults to the last 28 days, ending yesterday", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runReport(runtime, { report: "top_pages" });
    expect(calls[0]!.request.dateRanges).toEqual([{ startDate: "28daysAgo", endDate: "yesterday" }]);
  });

  it("never ends a range on today, whose data is still being processed", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    for (const range of ["last 7 days", "last 30 days", "yesterday"]) {
      await runReport(runtime, { report: "top_pages", date_range: range });
    }
    for (const call of calls) {
      expect(call.request.dateRanges?.[0]?.endDate).not.toBe("today");
    }
  });

  it("sends limit as a string, because Google types it as int64", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runReport(runtime, { report: "top_pages", limit: 5 });
    expect(calls[0]!.request.limit).toBe("5");
  });

  it("uses the explicit property over the configured default", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runReport(runtime, { report: "top_pages", property_id: "properties/987654321" });
    expect(calls[0]!.propertyId).toBe("987654321");
  });

  it("refuses a measurement id before spending a request", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await expect(
      runReport(runtime, { report: "top_pages", property_id: "G-ABC123XYZ" }),
    ).rejects.toThrow(/measurement id/);
    expect(calls).toHaveLength(0);
  });

  it("turns filter_contains into a dimension filter on the first dimension", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runReport(runtime, { report: "top_pages", filter_contains: "/blog" });
    expect(calls[0]!.request.dimensionFilter).toEqual({
      filter: {
        fieldName: "pagePath",
        stringFilter: { matchType: "CONTAINS", value: "/blog", caseSensitive: false },
      },
    });
  });

  it("explains why a dimensionless report cannot be filtered", async () => {
    const { runtime } = stubRuntime(SAMPLE);
    await expect(
      runReport(runtime, { report: "overview", filter_contains: "/blog" }),
    ).rejects.toThrow(/no dimension to filter on/);
  });

  it("redacts personal data out of the rendered rows", async () => {
    const { runtime } = stubRuntime({
      ...SAMPLE,
      rows: [
        {
          dimensionValues: [{ value: "/reset?token=9f8e7d6c5b4a39281706f5e4&user=ada@example.com" }],
          metricValues: [{ value: "1" }, { value: "1" }, { value: "1" }, { value: "0" }],
        },
      ],
    });
    const result = await runReport(runtime, { report: "top_pages" });
    expect(result.markdown).not.toContain("ada@example.com");
    expect(result.markdown).not.toContain("9f8e7d6c5b4a39281706f5e4");
    expect((result.details as { redactions: number }).redactions).toBeGreaterThan(0);
  });

  it("reports the property and fields it actually used", async () => {
    const { runtime } = stubRuntime(SAMPLE);
    const result = await runReport(runtime, { report: "top_pages" });
    expect(result.details).toMatchObject({
      propertyId: "123456789",
      dimensions: ["pagePath"],
    });
  });

  it("refuses a property outside the allowlist without calling Google", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE, {
      GA4_PROPERTY_ALLOWLIST: "555000111",
    });
    await expect(runReport(runtime, { report: "top_pages" })).rejects.toThrow(
      /not in this skill's allowlist/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("the compare command", () => {
  it("asks for two non-overlapping ranges of equal length", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runCompare(runtime, { report: "channels", date_range: "last 7 days" });

    const ranges = calls[0]!.request.dateRanges!;
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.name).toBe("current");
    expect(ranges[1]!.name).toBe("previous");
    expect(ranges[1]!.endDate < ranges[0]!.startDate.replace("daysAgo", "")).toBeTruthy();
  });

  it("says what is being compared with what", async () => {
    const { runtime } = stubRuntime(SAMPLE);
    const result = await runCompare(runtime, { report: "channels" });
    expect(result.markdown).toMatch(/Comparing last 28 days against the previous 28 days/);
  });
});

describe("the live command", () => {
  it("uses the realtime endpoint with a minute range, not a date range", async () => {
    const { runtime, realtimeCalls, calls } = stubRuntime(SAMPLE);
    await runRealtime(runtime, {});
    expect(calls).toHaveLength(0);
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]!.request).toMatchObject({
      minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
    });
  });

  it("warns that realtime is provisional and not comparable", async () => {
    const { runtime } = stubRuntime(SAMPLE);
    const result = await runRealtime(runtime, {});
    expect(result.markdown).toMatch(/provisional/);
    expect(result.markdown).toMatch(/not comparable/);
  });
});

describe("the query command", () => {
  it("rewrites a metric Google renamed, and says so", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    const result = await runQuery(runtime, { metrics: ["conversions"] });
    expect(calls[0]!.request.metrics).toEqual([{ name: "keyEvents" }]);
    expect(result.markdown).toMatch(/renamed conversions to keyEvents/);
  });

  it("blocks a person-identifying dimension before calling Google", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await expect(
      runQuery(runtime, { metrics: ["sessions"], dimensions: ["userId"] }),
    ).rejects.toThrow(/identifies individual people/);
    expect(calls).toHaveLength(0);
  });

  it("allows it once explicitly opted in", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE, {
      GA4_ALLOW_USER_DIMENSIONS: "true",
    });
    await runQuery(runtime, { metrics: ["sessions"], dimensions: ["userId"] });
    expect(calls).toHaveLength(1);
  });

  it("rejects more dimensions than Google accepts, without spending a request", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await expect(
      runQuery(runtime, {
        metrics: ["sessions"],
        dimensions: Array.from({ length: 10 }, (_, i) => `d${i}`),
      }),
    ).rejects.toThrow(/allows 9 dimensions/);
    expect(calls).toHaveLength(0);
  });

  it("sorts by a metric when order_by names one", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runQuery(runtime, { metrics: ["sessions"], order_by: "sessions" });
    expect(calls[0]!.request.orderBys).toEqual([{ desc: true, metric: { metricName: "sessions" } }]);
  });

  it("sorts by a dimension when order_by names something else", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runQuery(runtime, {
      metrics: ["sessions"],
      dimensions: ["date"],
      order_by: "date",
    });
    expect(calls[0]!.request.orderBys).toEqual([
      { desc: true, dimension: { dimensionName: "date" } },
    ]);
  });
});

describe("the query command's filters", () => {
  it("builds a dimension filter and says what it narrowed to", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    const result = await runQuery(runtime, {
      metrics: ["sessions"],
      dimensions: ["pagePath"],
      filters: [{ field: "pagePath", op: "contains", value: "/blog" }],
    });

    expect(calls[0]!.request.dimensionFilter).toEqual({
      filter: {
        fieldName: "pagePath",
        stringFilter: { matchType: "CONTAINS", value: "/blog", caseSensitive: false },
      },
    });
    expect(result.markdown).toMatch(/Filtered to rows where pagePath contains "\/blog"/);
  });

  it("routes a metric condition to metricFilter, not dimensionFilter", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runQuery(runtime, {
      metrics: ["sessions"],
      filters: [{ field: "sessions", op: "greater_than", value: "100" }],
    });
    expect(calls[0]!.request.metricFilter).toEqual({
      filter: {
        fieldName: "sessions",
        numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 100 } },
      },
    });
    expect(calls[0]!.request.dimensionFilter).toBeUndefined();
  });

  it("combines several conditions with AND", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runQuery(runtime, {
      metrics: ["sessions"],
      dimensions: ["pagePath", "country"],
      filters: [
        { field: "pagePath", op: "begins_with", value: "/docs" },
        { field: "country", op: "exact", value: "Germany" },
      ],
    });
    expect(calls[0]!.request.dimensionFilter?.andGroup?.expressions).toHaveLength(2);
  });

  it("splits an in_list value on commas", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await runQuery(runtime, {
      metrics: ["sessions"],
      dimensions: ["country"],
      filters: [{ field: "country", op: "in_list", value: "Germany, France ,Spain" }],
    });
    expect(calls[0]!.request.dimensionFilter?.filter?.inListFilter?.values).toEqual([
      "Germany",
      "France",
      "Spain",
    ]);
  });

  it("refuses a text operator on a metric instead of dropping the filter", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await expect(
      runQuery(runtime, {
        metrics: ["sessions"],
        filters: [{ field: "sessions", op: "contains", value: "10" }],
      }),
    ).rejects.toThrow(/is a metric, so it can only be filtered with greater_than or less_than/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-numeric value for a numeric comparison", async () => {
    const { runtime } = stubRuntime(SAMPLE);
    await expect(
      runQuery(runtime, {
        metrics: ["sessions"],
        filters: [{ field: "sessions", op: "greater_than", value: "lots" }],
      }),
    ).rejects.toThrow(/needs a number/);
  });

  it("refuses an unparseable regular expression before spending a request", async () => {
    const { runtime, calls } = stubRuntime(SAMPLE);
    await expect(
      runQuery(runtime, {
        metrics: ["sessions"],
        dimensions: ["pagePath"],
        filters: [{ field: "pagePath", op: "regex", value: "([unclosed" }],
      }),
    ).rejects.toThrow(/not a valid regular expression/);
    expect(calls).toHaveLength(0);
  });
});
