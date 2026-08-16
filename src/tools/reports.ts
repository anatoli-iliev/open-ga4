import type { OrderBy, RunReportRequest, RunReportResponse } from "../ga4/client.js";
import { quotaWarning } from "../ga4/client.js";
import { parseDateRange, precedingRange, type Ga4DateRange } from "../ga4/dates.js";
import { Ga4Error } from "../ga4/errors.js";
import { formatReport } from "../ga4/format.js";
import { buildFilters, type FilterCondition } from "../ga4/filters.js";
import { applyRenames, assertRealtimeFields, assertWithinLimits, LIMITS } from "../ga4/limits.js";
import { findPreset, PRESETS, PRESET_IDS } from "../ga4/presets.js";
import { assertDimensionsAllowed, thresholdProneDimensions } from "../privacy/policy.js";
import type { Ga4Runtime } from "../runtime.js";

/**
 * The reporting tools: `ga4_report`, `ga4_compare`, `ga4_realtime`, `ga4_query`.
 *
 * They share one pipeline (resolve property, apply renames, check policy,
 * enforce limits, call, format), so a privacy or correctness fix lands in all
 * of them at once.
 */

const CORE_PRESETS = PRESETS.filter((preset) => preset.kind === "core").map((preset) => preset.id);
const REALTIME_PRESETS = PRESETS.filter((preset) => preset.kind === "realtime").map((p) => p.id);

type ReportOutcome = {
  markdown: string;
  details: Record<string, unknown>;
};

/** Shared tail end: format, collect caveats, build the structured details. */
function present(
  response: RunReportResponse,
  runtime: Ga4Runtime,
  params: {
    tool: string;
    title: string;
    dateRangeLabel?: string;
    notes: string[];
    limit: number;
    propertyId: string;
    dimensions: readonly string[];
    metrics: readonly string[];
  },
): ReportOutcome {
  const notes = [...params.notes];

  const thresholdProne = thresholdProneDimensions(params.dimensions);
  if (thresholdProne.length > 0) {
    notes.push(
      `${thresholdProne.join(", ")} ${thresholdProne.length === 1 ? "is a dimension" : "are dimensions"} ` +
        `Google's minimum-aggregation thresholds apply to, so rows covering few users may be withheld.`,
    );
  }

  const quota = quotaWarning(response.propertyQuota);
  if (quota) {
    notes.push(quota);
  }

  const formatted = formatReport(response, {
    title: params.title,
    dateRangeLabel: params.dateRangeLabel,
    redaction: runtime.config.redaction,
    notes,
    maxRows: params.limit,
  });

  void runtime.audit.record({
    tool: params.tool,
    propertyId: params.propertyId,
    dimensions: params.dimensions,
    metrics: params.metrics,
    ...(params.dateRangeLabel ? { dateRange: params.dateRangeLabel } : {}),
    rows: formatted.rowsShown,
  });

  return {
    markdown: formatted.markdown,
    details: {
      propertyId: params.propertyId,
      dimensions: [...params.dimensions],
      metrics: [...params.metrics],
      dateRange: params.dateRangeLabel,
      rowsShown: formatted.rowsShown,
      rowsAvailable: formatted.rowsAvailable,
      redactions: formatted.redactions,
      caveats: formatted.caveats,
    },
  };
}

function dateRangeOf(input: string | undefined, start?: string, end?: string): Ga4DateRange {
  if (start && end) {
    return parseDateRange(`${start}..${end}`);
  }
  return parseDateRange(input ?? "last 28 days");
}

export type ReportParams = {
  report: string;
  property_id?: string;
  date_range?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  filter_contains?: string;
};

export async function runReport(
  runtime: Ga4Runtime,
  params: ReportParams,
  signal?: AbortSignal,
): Promise<ReportOutcome> {
  const preset = findPreset(params.report);
  if (!preset) {
    throw new Ga4Error(
      "INVALID_REQUEST",
      `Unknown report "${params.report}".`,
      `Available: ${CORE_PRESETS.join(", ")}.`,
    );
  }

  const propertyId = runtime.resolveProperty(params.property_id);
  const range = dateRangeOf(params.date_range, params.start_date, params.end_date);
  const limit = params.limit ?? Math.min(preset.limit, runtime.config.defaultRowLimit * 4);

  const notes: string[] = [];
  if (range.timezoneNote) {
    notes.push(range.timezoneNote);
  }
  if (preset.note) {
    notes.push(preset.note);
  }

  const custom = await runtime.userScopedCustomDimensions(propertyId, signal);
  assertDimensionsAllowed(preset.dimensions, runtime.config.access, custom);

  let dimensionFilter = preset.dimensionFilter;
  if (params.filter_contains) {
    const field = preset.dimensions[0];
    if (!field) {
      throw new Ga4Error(
        "INVALID_REQUEST",
        `The ${preset.id} report has no dimension to filter on.`,
        "Choose a report with rows (such as top_pages or traffic_sources), or use ga4_query.",
      );
    }
    dimensionFilter = {
      filter: {
        fieldName: field,
        stringFilter: { matchType: "CONTAINS", value: params.filter_contains, caseSensitive: false },
      },
    };
    notes.push(`Filtered to rows whose ${field} contains "${params.filter_contains}".`);
  }

  assertWithinLimits({ dimensions: preset.dimensions, metrics: preset.metrics, limit });

  const request: RunReportRequest = {
    dimensions: preset.dimensions.map((name) => ({ name })),
    metrics: preset.metrics.map((name) => ({ name })),
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    limit: String(limit),
    ...(preset.orderBys ? { orderBys: preset.orderBys } : {}),
    ...(dimensionFilter ? { dimensionFilter } : {}),
  };

  const client = await runtime.client();
  const response = await client.runReport(propertyId, request, signal);

  return present(response, runtime, {
    tool: "ga4_report",
    title: preset.intent.replace(/\.$/, ""),
    dateRangeLabel: range.label,
    notes,
    limit,
    propertyId,
    dimensions: preset.dimensions,
    metrics: preset.metrics,
  });
}

export type CompareParams = {
  report: string;
  property_id?: string;
  date_range?: string;
  limit?: number;
};

export async function runCompare(
  runtime: Ga4Runtime,
  params: CompareParams,
  signal?: AbortSignal,
): Promise<ReportOutcome> {
  const preset = findPreset(params.report);
  if (!preset) {
    throw new Ga4Error(
      "INVALID_REQUEST",
      `Unknown report "${params.report}".`,
      `Available: ${CORE_PRESETS.join(", ")}.`,
    );
  }

  const propertyId = runtime.resolveProperty(params.property_id);
  const current = dateRangeOf(params.date_range);
  const previous = precedingRange(current);
  const limit = params.limit ?? 10;

  const custom = await runtime.userScopedCustomDimensions(propertyId, signal);
  assertDimensionsAllowed(preset.dimensions, runtime.config.access, custom);
  assertWithinLimits({
    dimensions: preset.dimensions,
    metrics: preset.metrics,
    dateRangeCount: 2,
    limit,
  });

  const client = await runtime.client();
  const response = await client.runReport(
    propertyId,
    {
      dimensions: preset.dimensions.map((name) => ({ name })),
      metrics: preset.metrics.map((name) => ({ name })),
      dateRanges: [
        { startDate: current.startDate, endDate: current.endDate, name: "current" },
        { startDate: previous.startDate, endDate: previous.endDate, name: "previous" },
      ],
      limit: String(limit),
      ...(preset.orderBys ? { orderBys: preset.orderBys } : {}),
    },
    signal,
  );

  const notes = [
    `Comparing ${current.label} against the ${previous.label} immediately before it.`,
    ...(current.timezoneNote ? [current.timezoneNote] : []),
  ];

  return present(response, runtime, {
    tool: "ga4_compare",
    title: `${preset.intent.replace(/\.$/, "")}: period comparison`,
    dateRangeLabel: `${current.label} vs ${previous.label}`,
    notes,
    limit,
    propertyId,
    // A multi-range report adds a dateRange dimension column of its own.
    dimensions: [...preset.dimensions, "dateRange"],
    metrics: preset.metrics,
  });
}

export type RealtimeParams = {
  breakdown?: string;
  property_id?: string;
  limit?: number;
};

export async function runRealtime(
  runtime: Ga4Runtime,
  params: RealtimeParams,
  signal?: AbortSignal,
): Promise<ReportOutcome> {
  const breakdownId = params.breakdown ?? "realtime_now";
  const preset = findPreset(breakdownId);
  if (!preset || preset.kind !== "realtime") {
    throw new Ga4Error(
      "INVALID_REQUEST",
      `Unknown realtime breakdown "${breakdownId}".`,
      `Available: ${REALTIME_PRESETS.join(", ")}.`,
    );
  }

  const propertyId = runtime.resolveProperty(params.property_id);
  const limit = params.limit ?? preset.limit;

  assertRealtimeFields(preset.dimensions, preset.metrics);

  const client = await runtime.client();
  const response = await client.runRealtimeReport(
    propertyId,
    {
      dimensions: preset.dimensions.map((name) => ({ name })),
      metrics: preset.metrics.map((name) => ({ name })),
      minuteRanges: [{ startMinutesAgo: LIMITS.MINUTES_AGO_MAX, endMinutesAgo: 0 }],
      limit: String(limit),
      ...(preset.orderBys ? { orderBys: preset.orderBys } : {}),
    },
    signal,
  );

  return present(response, runtime, {
    tool: "ga4_realtime",
    title: preset.intent.replace(/\.$/, ""),
    dateRangeLabel: "last 30 minutes",
    notes: [
      "Realtime data is provisional and covers roughly the last 30 minutes. It is not " +
        "comparable with the standard reports, which are fully processed.",
    ],
    limit,
    propertyId,
    dimensions: preset.dimensions,
    metrics: preset.metrics,
  });
}

export type QueryParams = {
  metrics: string[];
  dimensions?: string[];
  property_id?: string;
  date_range?: string;
  start_date?: string;
  end_date?: string;
  filters?: FilterCondition[];
  order_by?: string;
  limit?: number;
};

export async function runQuery(
  runtime: Ga4Runtime,
  params: QueryParams,
  signal?: AbortSignal,
): Promise<ReportOutcome> {
  const propertyId = runtime.resolveProperty(params.property_id);
  const range = dateRangeOf(params.date_range, params.start_date, params.end_date);
  const limit = params.limit ?? runtime.config.defaultRowLimit;

  const metricRename = applyRenames(params.metrics);
  const dimensionRename = applyRenames(params.dimensions ?? []);
  const notes: string[] = [];
  for (const rewrite of [...metricRename.rewrites, ...dimensionRename.rewrites]) {
    notes.push(`Google renamed ${rewrite.from} to ${rewrite.to}; the report uses ${rewrite.to}.`);
  }
  if (range.timezoneNote) {
    notes.push(range.timezoneNote);
  }

  const custom = await runtime.userScopedCustomDimensions(propertyId, signal);
  assertDimensionsAllowed(dimensionRename.names, runtime.config.access, custom);
  assertWithinLimits({
    dimensions: dimensionRename.names,
    metrics: metricRename.names,
    limit,
  });

  const filters = buildFilters(params.filters ?? [], metricRename.names);
  if (filters.descriptions.length > 0) {
    notes.push(`Filtered to rows where ${filters.descriptions.join(" and ")}.`);
  }

  const orderBys: OrderBy[] | undefined = params.order_by
    ? metricRename.names.includes(params.order_by)
      ? [{ desc: true, metric: { metricName: params.order_by } }]
      : [{ desc: true, dimension: { dimensionName: params.order_by } }]
    : undefined;

  const client = await runtime.client();
  const response = await client.runReport(
    propertyId,
    {
      dimensions: dimensionRename.names.map((name) => ({ name })),
      metrics: metricRename.names.map((name) => ({ name })),
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      limit: String(limit),
      ...(orderBys ? { orderBys } : {}),
      ...(filters.dimensionFilter ? { dimensionFilter: filters.dimensionFilter } : {}),
      ...(filters.metricFilter ? { metricFilter: filters.metricFilter } : {}),
    },
    signal,
  );

  return present(response, runtime, {
    tool: "ga4_query",
    title: "Custom report",
    dateRangeLabel: range.label,
    notes,
    limit,
    propertyId,
    dimensions: dimensionRename.names,
    metrics: metricRename.names,
  });
}

export { PRESET_IDS };
