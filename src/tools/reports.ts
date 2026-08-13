import { Type } from "typebox";
import type { OrderBy, RunReportRequest, RunReportResponse } from "../ga4/client.js";
import { quotaWarning } from "../ga4/client.js";
import { parseDateRange, precedingRange, type Ga4DateRange } from "../ga4/dates.js";
import { formatReport } from "../ga4/format.js";
import { buildFilters, FILTER_OPERATORS, type FilterCondition } from "../ga4/filters.js";
import { applyRenames, assertRealtimeFields, assertWithinLimits, LIMITS } from "../ga4/limits.js";
import { findPreset, PRESETS, PRESET_IDS } from "../ga4/presets.js";
import { assertDimensionsAllowed, thresholdProneDimensions } from "../privacy/policy.js";
import type { Ga4Runtime } from "../runtime.js";

/**
 * The reporting tools: `ga4_report`, `ga4_compare`, `ga4_realtime`, `ga4_query`.
 *
 * They share one pipeline — resolve property, apply renames, check policy,
 * enforce limits, call, format — so a privacy or correctness fix lands in all
 * of them at once.
 */

const CORE_PRESETS = PRESETS.filter((preset) => preset.kind === "core").map((preset) => preset.id);
const REALTIME_PRESETS = PRESETS.filter((preset) => preset.kind === "realtime").map((p) => p.id);

const DATE_RANGES = [
  "yesterday",
  "last 7 days",
  "last 14 days",
  "last 28 days",
  "last 30 days",
  "last 90 days",
  "this week",
  "last week",
  "this month",
  "last month",
  "this year",
  "last year",
] as const;

function presetMenu(ids: readonly string[]): string {
  return PRESETS.filter((preset) => ids.includes(preset.id))
    .map((preset) => `  ${preset.id} — ${preset.intent}`)
    .join("\n");
}

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

export function reportTool(runtime: Ga4Runtime) {
  return {
    name: "ga4_report",
    label: "GA4 report",
    description:
      "Run a ready-made Google Analytics 4 report and get a markdown table back.\n\n" +
      "Use this for almost every analytics question. Pick the report that matches the intent; " +
      "the dimension and metric names are chosen for you, so there is nothing to guess.\n\n" +
      `Reports available:\n${presetMenu(CORE_PRESETS)}\n\n` +
      "Date ranges always end yesterday, because Google is still processing today's data. " +
      "For live numbers use ga4_realtime instead. For a dimension or metric no report covers, " +
      "use ga4_query. To find out what a property supports, use ga4_fields.",
    promptSnippet: "ga4_report — Google Analytics reports (traffic, pages, sources, conversions, revenue).",
    parameters: Type.Object({
      report: Type.Union(
        CORE_PRESETS.map((id) => Type.Literal(id)),
        { description: "Which ready-made report to run." },
      ),
      property_id: Type.Optional(
        Type.String({
          description:
            "Numeric GA4 property id, for example 123456789. Not the G-XXXXXXX measurement id. " +
            "Defaults to the configured property.",
        }),
      ),
      date_range: Type.Optional(
        Type.Union(
          DATE_RANGES.map((value) => Type.Literal(value)),
          { description: "Period to report on. Defaults to last 28 days." },
        ),
      ),
      start_date: Type.Optional(Type.String({ description: "Custom range start, YYYY-MM-DD." })),
      end_date: Type.Optional(Type.String({ description: "Custom range end, YYYY-MM-DD." })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: LIMITS.MAX_ROWS, description: "Maximum rows." }),
      ),
      filter_contains: Type.Optional(
        Type.String({
          description:
            "Keep only rows whose first dimension contains this text — for example a URL path " +
            "fragment, or a traffic source name.",
        }),
      ),
    }),
    async execute(params: {
      report: string;
      property_id?: string;
      date_range?: string;
      start_date?: string;
      end_date?: string;
      limit?: number;
      filter_contains?: string;
    }, signal?: AbortSignal): Promise<ReportOutcome> {
      const preset = findPreset(params.report);
      if (!preset) {
        throw new Error(`Unknown report "${params.report}". Available: ${CORE_PRESETS.join(", ")}.`);
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
          throw new Error(
            `The ${preset.id} report has no dimension to filter on. Choose a report with rows ` +
              `(such as top_pages or traffic_sources), or use ga4_query.`,
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
    },
  };
}

export function compareTool(runtime: Ga4Runtime) {
  return {
    name: "ga4_compare",
    label: "GA4 period comparison",
    description:
      "Compare one Google Analytics 4 report across two periods and show the change.\n\n" +
      "Use this when the question is about movement — 'is traffic up', 'did last week beat the " +
      "week before', 'how does this month compare to last'. Returns both periods side by side " +
      "with the absolute and percentage change.\n\n" +
      `Reports available:\n${presetMenu(CORE_PRESETS)}`,
    promptSnippet: "ga4_compare — compare a Google Analytics report across two periods, with deltas.",
    parameters: Type.Object({
      report: Type.Union(CORE_PRESETS.map((id) => Type.Literal(id))),
      property_id: Type.Optional(Type.String()),
      date_range: Type.Optional(
        Type.Union(DATE_RANGES.map((value) => Type.Literal(value)), {
          description: "The recent period. Defaults to last 28 days.",
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(params: {
      report: string;
      property_id?: string;
      date_range?: string;
      limit?: number;
    }, signal?: AbortSignal): Promise<ReportOutcome> {
      const preset = findPreset(params.report);
      if (!preset) {
        throw new Error(`Unknown report "${params.report}". Available: ${CORE_PRESETS.join(", ")}.`);
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
        title: `${preset.intent.replace(/\.$/, "")} — period comparison`,
        dateRangeLabel: `${current.label} vs ${previous.label}`,
        notes,
        limit,
        propertyId,
        // A multi-range report adds a dateRange dimension column of its own.
        dimensions: [...preset.dimensions, "dateRange"],
        metrics: preset.metrics,
      });
    },
  };
}

export function realtimeTool(runtime: Ga4Runtime) {
  return {
    name: "ga4_realtime",
    label: "GA4 realtime",
    description:
      "Who is on the site right now, from the Google Analytics 4 realtime API — roughly the last " +
      "30 minutes.\n\n" +
      "Use this when the question is about the present moment — 'how many people are on the site', " +
      "'is anyone reading the launch post', 'did the campaign just go live'. For any question " +
      "about a day or longer, use ga4_report instead.\n\n" +
      "This is the only tool that reports on 'now'. Realtime is a much smaller data set than the " +
      "standard reports: there are no sessions, no page paths, no traffic sources and no browser " +
      "breakdown in realtime at all. Its numbers are provisional and are not comparable with " +
      "ga4_report.\n\n" +
      `Breakdowns available:\n${presetMenu(REALTIME_PRESETS)}`,
    promptSnippet: "ga4_realtime — active users on the site in the last 30 minutes.",
    parameters: Type.Object({
      breakdown: Type.Optional(
        Type.Union(REALTIME_PRESETS.map((id) => Type.Literal(id)), {
          description: "How to break down the active users. Defaults to by country.",
        }),
      ),
      property_id: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(params: {
      breakdown?: string;
      property_id?: string;
      limit?: number;
    }, signal?: AbortSignal): Promise<ReportOutcome> {
      const preset = findPreset(params.breakdown ?? "realtime_now");
      if (!preset || preset.kind !== "realtime") {
        throw new Error(`Unknown realtime breakdown. Available: ${REALTIME_PRESETS.join(", ")}.`);
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
    },
  };
}

export function queryTool(runtime: Ga4Runtime) {
  return {
    name: "ga4_query",
    label: "GA4 custom query",
    description:
      "Run a Google Analytics 4 report with dimensions and metrics you choose.\n\n" +
      "Use this only when ga4_report has no preset for what is being asked. It needs exact GA4 " +
      "API names — run ga4_fields first to find them rather than guessing, because a wrong name " +
      "is a wasted call.\n\n" +
      "Supports filters combined with AND. At most 9 dimensions and 10 metrics. Some combinations " +
      "are impossible because the fields are measured at different scopes; if Google rejects a " +
      "pairing, ga4_fields shows what is compatible.",
    promptSnippet: "ga4_query — custom Google Analytics report with explicit dimensions and metrics.",
    parameters: Type.Object({
      metrics: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: LIMITS.MAX_METRICS,
        description: "Exact GA4 metric API names, for example sessions, activeUsers, keyEvents.",
      }),
      dimensions: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: LIMITS.MAX_DIMENSIONS,
          description: "Exact GA4 dimension API names, for example pagePath, country, date.",
        }),
      ),
      property_id: Type.Optional(Type.String()),
      date_range: Type.Optional(Type.Union(DATE_RANGES.map((value) => Type.Literal(value)))),
      start_date: Type.Optional(Type.String({ description: "Custom range start, YYYY-MM-DD." })),
      end_date: Type.Optional(Type.String({ description: "Custom range end, YYYY-MM-DD." })),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String({ description: "Dimension or metric API name to filter on." }),
            op: Type.Union(FILTER_OPERATORS.map((value) => Type.Literal(value))),
            value: Type.String({
              description: "Text to match, a comma-separated list for in_list, or a number.",
            }),
          }),
          {
            maxItems: 5,
            description:
              "Conditions combined with AND. Metrics accept only greater_than and less_than.",
          },
        ),
      ),
      order_by: Type.Optional(
        Type.String({ description: "Metric or dimension name to sort by, highest first." }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.MAX_ROWS })),
    }),
    async execute(params: {
      metrics: string[];
      dimensions?: string[];
      property_id?: string;
      date_range?: string;
      start_date?: string;
      end_date?: string;
      filters?: FilterCondition[];
      order_by?: string;
      limit?: number;
    }, signal?: AbortSignal): Promise<ReportOutcome> {
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
    },
  };
}

export const REPORT_TOOL_NAMES = ["ga4_report", "ga4_compare", "ga4_realtime", "ga4_query"] as const;

export { PRESET_IDS };
