import { diagnose } from "../ga4/errors.js";
import { RENAMED_FIELDS } from "../ga4/limits.js";
import { classifyDimension } from "../privacy/policy.js";
/**
 * The operations that answer "what can I even ask for": the `fields`,
 * `properties` and `doctor` commands.
 *
 * All three read from the property itself rather than from a shipped list, so
 * a custom dimension added last week shows up without a skill update.
 */
/** Table cells must not be able to forge table structure. */
function cell(value) {
    return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}
function scoreMatch(field, needle) {
    const api = (field.apiName ?? "").toLowerCase();
    const ui = (field.uiName ?? "").toLowerCase();
    const description = (field.description ?? "").toLowerCase();
    if (api === needle || ui === needle)
        return 100;
    if (api.startsWith(needle) || ui.startsWith(needle))
        return 80;
    if (api.includes(needle) || ui.includes(needle))
        return 60;
    if (description.includes(needle))
        return 30;
    return 0;
}
export async function runFields(runtime, params, signal) {
    const propertyId = runtime.resolveProperty(params.property_id);
    const needle = params.query.trim().toLowerCase();
    const limit = params.limit ?? 15;
    const kind = params.kind ?? "any";
    const metadata = await runtime.metadata(propertyId, signal);
    const pool = [
        ...(kind !== "metric" ? (metadata.dimensions ?? []).map((f) => ({ field: f, kind: "dimension" })) : []),
        ...(kind !== "dimension" ? (metadata.metrics ?? []).map((f) => ({ field: f, kind: "metric" })) : []),
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
        lines.push(`No dimension or metric on property ${propertyId} matches that. Try a broader word: ` +
            `'page', 'user', 'session', 'revenue', 'source', 'event'.`);
    }
    else {
        lines.push("| API name | Shown in GA4 as | Kind | Meaning |", "| --- | --- | --- | --- |", ...matches.map((entry) => {
            const api = entry.field.apiName ?? "";
            const flags = [];
            if (entry.field.customDefinition) {
                flags.push("custom");
            }
            if (entry.kind === "dimension" && classifyDimension(api) === "user-identifying") {
                flags.push("blocked by default");
            }
            const kindCell = flags.length > 0 ? `${entry.kind} (${flags.join(", ")})` : entry.kind;
            const meaning = (entry.field.description ?? "").replace(/\s+/g, " ").slice(0, 140);
            return `| \`${cell(api)}\` | ${cell(entry.field.uiName ?? "")} | ${kindCell} | ${cell(meaning)} |`;
        }));
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
}
function renderChecks(checks, extra) {
    const symbol = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
    const lines = ["## GA4 setup check", ""];
    for (const check of checks) {
        lines.push(`- **${symbol[check.status]}** ${check.label}: ${check.detail}`);
        if (check.fix) {
            lines.push(`    - Fix: ${check.fix}`);
        }
    }
    if (extra.length > 0) {
        lines.push("", ...extra);
    }
    return lines.join("\n");
}
/**
 * The GA4 properties a credential can read. Setup needs this before any
 * report is possible, and doctor lists the same properties as one of
 * its checks, so both call this rather than each parsing account summaries
 * on their own.
 */
export async function runProperties(runtime, _params, signal) {
    const client = await runtime.client();
    const summaries = await client.listAccountSummaries(signal);
    const properties = [];
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
    const lines = ["## GA4 properties", ""];
    if (properties.length > 0) {
        lines.push("| Property id | Name | Account |", "| --- | --- | --- |", ...properties.map((p) => `| \`${cell(p.id)}\` | ${cell(p.name)} | ${cell(p.account)} |`));
    }
    else {
        lines.push("No properties reachable with this credential.");
    }
    return {
        markdown: lines.join("\n"),
        details: { properties },
    };
}
export async function runDiagnose(runtime, params, signal) {
    const checks = [];
    const extra = [];
    let properties = [];
    // 1. Credentials.
    let client;
    try {
        client = await runtime.client();
        const probes = runtime.probes();
        const used = probes.find((probe) => probe.status === "used");
        checks.push({
            id: "credentials",
            label: "Google credentials",
            status: "pass",
            // used.path is the real path once a credential is confirmed to have
            // loaded successfully (see resolveCredentials in auth/credentials.ts);
            // naming it is what makes a stale path pointing at the wrong key file
            // findable, which the label alone (just "GA4_CREDENTIALS (file)")
            // cannot say.
            detail: `loaded from ${used?.label ?? "an unknown source"}${used?.path ? ` at ${used.path}` : ""}${runtime.principal() ? `, service account ${runtime.principal()}` : ""}`,
        });
    }
    catch (error) {
        const named = diagnose(error, { principal: runtime.principal() });
        checks.push({
            id: "credentials",
            label: "Google credentials",
            status: "fail",
            detail: named.message,
            fix: named.fix,
            code: named.code,
        });
        return { markdown: renderChecks(checks, extra), details: { ok: false, checks } };
    }
    // 2. Admin API and property discovery, in one step: listing properties is
    //    both the check and the thing people most often need.
    try {
        const listed = await runProperties(runtime, {}, signal);
        properties = listed.details.properties;
        checks.push({
            id: "admin_api",
            label: "Admin API and property access",
            status: "pass",
            detail: `${properties.length} propert${properties.length === 1 ? "y" : "ies"} reachable`,
        });
    }
    catch (error) {
        const named = diagnose(error, { principal: runtime.principal() });
        checks.push({
            id: "admin_api",
            label: "Admin API and property access",
            status: "fail",
            detail: named.message,
            fix: named.fix,
            code: named.code,
        });
    }
    // 3. A real report, which is the only thing that proves the Data API works.
    let propertyId;
    try {
        propertyId = runtime.resolveProperty(params.property_id ?? properties[0]?.id);
    }
    catch (error) {
        const named = diagnose(error);
        checks.push({
            id: "property_selection",
            label: "Property selection",
            status: "fail",
            detail: named.message,
            fix: named.fix,
            code: named.code,
        });
    }
    if (propertyId) {
        try {
            const response = await client.runReport(propertyId, {
                metrics: [{ name: "activeUsers" }],
                dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
                limit: "1",
            }, signal);
            const users = response.rows?.[0]?.metricValues?.[0]?.value ?? "0";
            checks.push({
                id: "data_api_report",
                label: "Data API report",
                status: "pass",
                detail: `property ${propertyId} returned ${users} active users over the last 7 days`,
            });
            if (users === "0") {
                extra.push("The query worked but returned zero users. That is a real answer, not an error: " +
                    "check the property is the one receiving traffic, and that the date range is after " +
                    "the property started collecting.");
            }
        }
        catch (error) {
            const named = diagnose(error, { principal: runtime.principal(), propertyId });
            checks.push({
                id: "data_api_report",
                label: "Data API report",
                status: "fail",
                detail: named.message,
                fix: named.fix,
                code: named.code,
            });
        }
    }
    // 4. Privacy posture, so it is visible rather than assumed.
    const { redaction, access } = runtime.config;
    checks.push({
        id: "privacy_settings",
        label: "Privacy settings",
        status: redaction.enabled ? "pass" : "fail",
        detail: redaction.enabled
            ? `redaction on; user-identifying dimensions ${access.allowUserIdentifyingDimensions ? "allowed" : "blocked"}; property allowlist ${access.propertyAllowlist.length > 0 ? access.propertyAllowlist.join(", ") : "not set"}`
            : "redaction is turned OFF, so personal data in URLs will reach the model",
        fix: redaction.enabled
            ? undefined
            : "Unset the GA4_REDACT environment variable, or set it to a truthy value (1, true, yes, or on).",
    });
    if (properties.length > 0) {
        extra.push("", "**Properties this credential can read**", "", "| Property id | Name | Account |", "| --- | --- | --- |", ...properties.map((p) => `| \`${cell(p.id)}\` | ${cell(p.name)} | ${cell(p.account)} |`));
    }
    const ok = checks.every((check) => check.status !== "fail");
    return {
        markdown: renderChecks(checks, extra),
        details: { ok, checks, properties },
    };
}
