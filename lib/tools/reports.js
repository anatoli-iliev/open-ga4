import { quotaWarning } from "../ga4/client.js";
import { parseDateRange, precedingRange } from "../ga4/dates.js";
import { Ga4Error } from "../ga4/errors.js";
import { flattenNewlines, formatReport } from "../ga4/format.js";
import { buildFilters } from "../ga4/filters.js";
import { applyRenames, assertRealtimeFields, assertWithinLimits, Ga4RequestError, LIMITS } from "../ga4/limits.js";
import { findPreset, PRESETS } from "../ga4/presets.js";
import { assertDimensionsAllowed, thresholdProneDimensions } from "../privacy/policy.js";
/**
 * The reporting operations behind the `report`, `compare`, `live` and
 * `query` commands.
 *
 * They share one pipeline (resolve property, apply renames, check policy,
 * enforce limits, call, format), so a privacy or correctness fix lands in all
 * of them at once.
 */
const CORE_PRESETS = PRESETS.filter((preset) => preset.kind === "core").map((preset) => preset.id);
const REALTIME_PRESETS = PRESETS.filter((preset) => preset.kind === "realtime").map((p) => p.id);
/** Shared tail end: format, collect caveats, build the structured details. */
function present(response, runtime, params) {
    const notes = [...params.notes];
    const thresholdProne = thresholdProneDimensions(params.dimensions);
    if (thresholdProne.length > 0) {
        notes.push(`${thresholdProne.join(", ")} ${thresholdProne.length === 1 ? "is a dimension" : "are dimensions"} ` +
            `Google's minimum-aggregation thresholds apply to, so rows covering few users may be withheld.`);
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
            // The actual figures, already formatted and redacted by formatReport,
            // so --json has an answer that is not "re-parse the markdown table".
            rows: formatted.rows,
            // The same untrusted-input warning the markdown table's lead-in gives,
            // carried alongside rows rather than left implicit or buried in
            // caveats: dimension values are visitor-authored, and redaction alone
            // does not mark that for a consumer reading only the JSON.
            rowsWarning: formatted.rowsWarning,
            caveats: formatted.caveats,
        },
    };
}
function dateRangeOf(input, start, end) {
    if (start && end) {
        return parseDateRange(`${start}..${end}`);
    }
    if (start || end) {
        // Half a range used to fall through to the default 28 days, so a report
        // asked for one period silently arrived measuring another, with a heading
        // that named the period nobody asked about. That is the exact defect
        // README.md holds against a competing project (a filter that parses and is
        // then dropped, returning whole-site numbers with no error), and a wrong
        // number that looks right is worse than a refusal.
        const given = start ? "--start" : "--end";
        const missing = start ? "--end" : "--start";
        throw new Ga4RequestError("INCOMPLETE_DATE_RANGE", `${given} was given without ${missing}, and a date range needs both ends. Nothing was ` +
            `assumed for the other one: this report would otherwise have covered the default last ` +
            `28 days rather than the period asked for. Give both, or use --range for a named period ` +
            `such as "last 7 days".`);
    }
    return parseDateRange(input ?? "last 28 days");
}
export async function runReport(runtime, params, signal) {
    // `kind`, not merely "a preset with this id exists". findPreset searches
    // every preset, realtime ones included, so `report realtime_now` used to
    // build a 28-day report and head it "who is on the site right now": an
    // answer to a question nobody asked, labelled as the answer to the one they
    // did. runRealtime has always checked this in the other direction.
    const preset = findPreset(params.report);
    if (!preset || preset.kind !== "core") {
        throw new Ga4Error("INVALID_REQUEST", `Unknown report "${params.report}".`, `Available: ${CORE_PRESETS.join(", ")}. For ${REALTIME_PRESETS.join(" or ")}, use live.`);
    }
    const propertyId = runtime.resolveProperty(params.property_id);
    const range = dateRangeOf(params.date_range, params.start_date, params.end_date);
    const limit = params.limit ?? Math.min(preset.limit, runtime.config.defaultRowLimit * 4);
    const notes = [];
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
            throw new Ga4Error("INVALID_REQUEST", `The ${preset.id} report has no dimension to filter on.`, "Choose a report with rows (such as top_pages or traffic_sources), or use query.");
        }
        dimensionFilter = {
            filter: {
                fieldName: field,
                stringFilter: { matchType: "CONTAINS", value: params.filter_contains, caseSensitive: false },
            },
        };
        // Flattened for the same reason as the query filter descriptions in
        // src/ga4/filters.ts: this is prose, outside the fenced block, and the
        // value came from argv.
        notes.push(`Filtered to rows whose ${field} contains "${flattenNewlines(params.filter_contains)}".`);
    }
    assertWithinLimits({ dimensions: preset.dimensions, metrics: preset.metrics, limit });
    const request = {
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
        tool: "report",
        title: preset.intent.replace(/\.$/, ""),
        dateRangeLabel: range.label,
        notes,
        limit,
        propertyId,
        dimensions: preset.dimensions,
        metrics: preset.metrics,
    });
}
export async function runCompare(runtime, params, signal) {
    // Same check as runReport, and for the same reason: comparing "who is on the
    // site right now" against the 28 days before it is not a thing realtime data
    // can answer.
    const preset = findPreset(params.report);
    if (!preset || preset.kind !== "core") {
        throw new Ga4Error("INVALID_REQUEST", `Unknown report "${params.report}".`, `Available: ${CORE_PRESETS.join(", ")}. Realtime data covers about 30 minutes, so there ` +
            `is no period to compare it with.`);
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
    const response = await client.runReport(propertyId, {
        dimensions: preset.dimensions.map((name) => ({ name })),
        metrics: preset.metrics.map((name) => ({ name })),
        dateRanges: [
            { startDate: current.startDate, endDate: current.endDate, name: "current" },
            { startDate: previous.startDate, endDate: previous.endDate, name: "previous" },
        ],
        limit: String(limit),
        ...(preset.orderBys ? { orderBys: preset.orderBys } : {}),
    }, signal);
    const notes = [
        `Comparing ${current.label} against the ${previous.label} immediately before it.`,
        ...(current.timezoneNote ? [current.timezoneNote] : []),
    ];
    return present(response, runtime, {
        tool: "compare",
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
export async function runRealtime(runtime, params, signal) {
    const breakdownId = params.breakdown ?? "realtime_now";
    const preset = findPreset(breakdownId);
    if (!preset || preset.kind !== "realtime") {
        throw new Ga4Error("INVALID_REQUEST", `Unknown realtime breakdown "${breakdownId}".`, `Available: ${REALTIME_PRESETS.join(", ")}.`);
    }
    const propertyId = runtime.resolveProperty(params.property_id);
    const limit = params.limit ?? preset.limit;
    assertRealtimeFields(preset.dimensions, preset.metrics);
    const client = await runtime.client();
    const response = await client.runRealtimeReport(propertyId, {
        dimensions: preset.dimensions.map((name) => ({ name })),
        metrics: preset.metrics.map((name) => ({ name })),
        minuteRanges: [{ startMinutesAgo: LIMITS.MINUTES_AGO_MAX, endMinutesAgo: 0 }],
        limit: String(limit),
        ...(preset.orderBys ? { orderBys: preset.orderBys } : {}),
    }, signal);
    return present(response, runtime, {
        tool: "live",
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
export async function runQuery(runtime, params, signal) {
    const propertyId = runtime.resolveProperty(params.property_id);
    const range = dateRangeOf(params.date_range, params.start_date, params.end_date);
    const limit = params.limit ?? runtime.config.defaultRowLimit;
    const metricRename = applyRenames(params.metrics);
    const dimensionRename = applyRenames(params.dimensions ?? []);
    const notes = [];
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
    const orderBys = params.order_by
        ? metricRename.names.includes(params.order_by)
            ? [{ desc: true, metric: { metricName: params.order_by } }]
            : [{ desc: true, dimension: { dimensionName: params.order_by } }]
        : undefined;
    const client = await runtime.client();
    const response = await client.runReport(propertyId, {
        dimensions: dimensionRename.names.map((name) => ({ name })),
        metrics: metricRename.names.map((name) => ({ name })),
        dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
        limit: String(limit),
        ...(orderBys ? { orderBys } : {}),
        ...(filters.dimensionFilter ? { dimensionFilter: filters.dimensionFilter } : {}),
        ...(filters.metricFilter ? { metricFilter: filters.metricFilter } : {}),
    }, signal);
    return present(response, runtime, {
        tool: "query",
        title: "Custom report",
        dateRangeLabel: range.label,
        notes,
        limit,
        propertyId,
        dimensions: dimensionRename.names,
        metrics: metricRename.names,
    });
}
