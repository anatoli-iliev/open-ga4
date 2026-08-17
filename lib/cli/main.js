import { configFromEnv } from "../config.js";
import { diagnose } from "../ga4/errors.js";
import { FILTER_OPERATORS } from "../ga4/filters.js";
import { redactText } from "../privacy/redact.js";
import { createRuntime } from "../runtime.js";
import { setupStateFrom } from "../setup/state.js";
import { runCompare, runQuery, runRealtime, runReport } from "../tools/reports.js";
import { runDiagnose, runFields, runProperties } from "../tools/discovery.js";
import { parseArgs, UsageError } from "./args.js";
import { EXIT, exitCodeFor } from "./exit.js";
/**
 * A string literal, not a read of package.json at runtime: package.json is
 * not shipped inside the skill bundle, so a runtime read would work in this
 * checkout and fail after install. src/cli/main.test.ts asserts this equals
 * package.json's version, so the two cannot silently drift apart.
 */
export const VERSION = "0.1.0";
const USAGE = `open-ga4: read-only Google Analytics 4 answers.

Usage: node <skill-dir>/lib/cli.js <command> [options]

Commands:
  doctor [--json]            Check setup and report the one thing to fix next
  report <preset>            One ready-made report
  compare <preset>           The same report across two periods
  live [breakdown]           Active users in roughly the last 30 minutes
  query                      Explicit dimensions, metrics, filters and sort
  fields <search>            Search the property's live field catalog
  properties                 List the properties this credential can read

query's --filter is one condition, field:operator:value (for example
country:exact:US). Only the first two colons split the expression, so the
value may contain colons of its own, such as a full URL (pageLocation and
pageReferrer are URLs). Operators: ${FILTER_OPERATORS.join(", ")}.

Run a command with --help for its options.
Settings live in the environment; see SKILL.md.
`;
export async function main(argv, env, streams) {
    let parsed;
    try {
        parsed = parseArgs(argv);
    }
    catch (error) {
        // redactText here too, not only on the paths below. A parse failure quotes
        // the argv token it could not read, and argv is the one place a person
        // pastes things: `--property <a key they had on the clipboard>` prints
        // that value back out. redactText is unconditional by design, so there is
        // no path out of this process that skips it.
        streams.err(`error: ${redactText(error instanceof Error ? error.message : String(error))}\n`);
        return EXIT.BAD_INPUT;
    }
    if (parsed.kind === "help") {
        streams.out(USAGE);
        return EXIT.OK;
    }
    if (parsed.kind === "version") {
        streams.out(`${VERSION}\n`);
        return EXIT.OK;
    }
    const warnings = [];
    const config = configFromEnv(env, (m) => warnings.push(m));
    const runtime = createRuntime({ config, env, onWarning: (m) => warnings.push(m) });
    /**
     * Warnings go out on both paths, and through redactText like everything
     * else this process prints.
     *
     * Both halves of that were wrong. They were printed only when the command
     * succeeded, which is backwards: a warning says a setting was ignored, and
     * suppressing it exactly when the command then fails hides the explanation
     * at the moment it is needed (an ignored GA4_PROPERTY_ALLOWLIST entry is
     * why the property was refused, and only the warning says so). And they were
     * printed raw, although they quote values a person typed:
     * configFromEnv echoes the allowlist entry it rejected, and the audit-log
     * warning carries a path.
     */
    const flushWarnings = () => {
        for (const warning of warnings)
            streams.err(`warning: ${redactText(warning)}\n`);
        warnings.length = 0;
    };
    try {
        const result = await dispatch(runtime, parsed);
        flushWarnings();
        streams.out(result.endsWith("\n") ? result : `${result}\n`);
        return EXIT.OK;
    }
    catch (error) {
        flushWarnings();
        if (error instanceof UsageError) {
            // A UsageError raised while converting flags in dispatch (a missing
            // positional, a --limit that is not a number) is the same kind of
            // problem as one from parseArgs: bad input, entirely local, nothing to
            // do with Google. It gets the same exit code, so the agent does not go
            // looking for a machine-readable reason from Google that was never
            // asked for.
            streams.err(`error: ${redactText(error.message)}\n`);
            return EXIT.BAD_INPUT;
        }
        // Never let a traceback reach the user: it names the wrong problem. The
        // taxonomy already maps every known failure to a sentence with a fix, and
        // redactText keeps a credential out of the message on every path.
        const named = diagnose(error, { principal: runtime.principal() });
        streams.err(`error: ${redactText(named.toString())}\n`);
        return exitCodeFor(named);
    }
}
/** A flag's raw value, or undefined if it was not given. Every flag this CLI
 * defines takes a value, so one given bare (`--property` with nothing after
 * it) is a mistake worth naming rather than silently coercing. */
function str(flags, name) {
    const value = flags[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string") {
        throw new UsageError(`--${name} needs a value.`);
    }
    return value;
}
/** A flag's value as a number. Number(true) is 1, so a bare boolean flag must
 * be rejected explicitly rather than silently read as a limit of 1. */
function num(flags, name) {
    const raw = str(flags, name);
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new UsageError(`--${name} must be a number; ${JSON.stringify(raw)} is not one.`);
    }
    return value;
}
/** A flag's value split on commas, trimmed, empty entries dropped. */
function csv(flags, name) {
    const raw = str(flags, name);
    if (raw === undefined)
        return undefined;
    return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
const FIELD_KINDS = ["any", "dimension", "metric"];
function kindFlag(flags) {
    const raw = str(flags, "kind");
    if (raw === undefined)
        return undefined;
    if (!FIELD_KINDS.includes(raw)) {
        throw new UsageError(`--kind must be one of ${FIELD_KINDS.join(", ")}; got ${JSON.stringify(raw)}.`);
    }
    return raw;
}
/**
 * query's --filter is one condition, `field:operator:value` (for example
 * `country:exact:US`). Only the first two colons are significant: field is
 * everything before the first, operator is everything between the first and
 * second, and value is everything after the second, colons and all. This
 * matters because pageLocation and pageReferrer are full URLs, and filtering
 * on one is ordinary, not an edge case: a URL's own colon (its scheme
 * separator) must survive intact in the value rather than be mistaken for
 * the delimiter; truncating there would silently misread the request rather
 * than raise.
 *
 * A field or an operator cannot themselves contain a colon (there is no
 * legitimate reason for either to), so a missing colon still raises, and the
 * operator is checked against FILTER_OPERATORS here rather than left for
 * buildFilters downstream, so a typo like `a:b:c:d` is rejected for the real
 * reason, an unknown operator (`b`), naming the valid ones, rather than a
 * generic "too many segments" that does not exist as a concept once the value
 * itself is unbounded.
 */
function filterFlag(flags) {
    const raw = str(flags, "filter");
    if (raw === undefined)
        return undefined;
    const first = raw.indexOf(":");
    const second = first === -1 ? -1 : raw.indexOf(":", first + 1);
    const field = first === -1 ? "" : raw.slice(0, first);
    const op = second === -1 ? "" : raw.slice(first + 1, second);
    if (field === "" || !FILTER_OPERATORS.includes(op)) {
        throw new UsageError(`--filter must look like field:operator:value (got ${JSON.stringify(raw)}). Operators: ` +
            `${FILTER_OPERATORS.join(", ")}.`);
    }
    return [{ field, op: op, value: raw.slice(second + 1) }];
}
/** The first positional argument, or a UsageError pointing at a worked example. */
function requirePositional(positional, example) {
    const value = positional[0];
    if (!value) {
        throw new UsageError(`Missing argument. For example: ${example}`);
    }
    return value;
}
/** Every operation returns `{ markdown, details }`; `--json` selects `details` over `markdown`. */
function output(result, json) {
    return json ? JSON.stringify(result.details, null, 2) : result.markdown;
}
/**
 * A fresh property listing for `no_property_selected`: the one state where
 * the agent must list the options and ask, rather than guess which property
 * the user meant (a confident answer about the wrong website is the worst
 * outcome available here). Fetched again rather than reused from
 * runDiagnose's own check, because that check may have found nothing for a
 * reason that has since cleared.
 *
 * Failing to enumerate is not itself a setup blocker: that already happened,
 * one way or another, before setupStateFrom ever produced
 * "no_property_selected". So a failure here degrades to an empty list
 * rather than throwing or changing `blocked_on`.
 */
async function propertiesToOffer(runtime) {
    try {
        const { details } = await runProperties(runtime, {});
        const { properties } = details;
        return properties.map((property) => ({ id: property.id, name: property.name }));
    }
    catch {
        return [];
    }
}
/**
 * `--json`'s value as the boolean it is: true for a bare `--json` (parseArgs
 * hands that back as the literal boolean `true`) or an explicit truthy
 * spelling, false when the flag was not given at all or was explicitly
 * turned off. `--json=false` must select markdown, not JSON: a value merely
 * being *present* is not the same question as what it says. Same true/false
 * spellings src/config.ts's isTrue/isFalse already use, for one convention
 * across the codebase.
 */
function jsonFlag(flags) {
    const value = flags.json;
    if (value === undefined)
        return false;
    if (typeof value === "boolean")
        return value;
    return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
/**
 * Converts each command's flags into the operation's own parameter object and
 * returns its markdown, or with `--json`, its structured details instead.
 * Kept in this file, not split out: this mapping is what a reviewer most
 * needs to see in one place.
 */
export async function dispatch(runtime, parsed) {
    const { command, positional, flags } = parsed;
    // Read unconditionally, before the switch, so every command's flags object
    // is touched regardless of which branch runs below (src/cli/main.test.ts's
    // "every KNOWN_FLAGS entry reaches a real field" suite checks that every
    // declared flag is actually read).
    const json = jsonFlag(flags);
    switch (command) {
        case "doctor": {
            const result = await runDiagnose(runtime, {});
            if (json) {
                // doctor's own `details` is the raw Check[] the markdown checklist
                // renders from: useful for a person, but still a wall of everything
                // that was checked. setupStateFrom reduces that to the one blocking
                // step, which is what --json is for on this command specifically.
                const { checks } = result.details;
                const state = setupStateFrom(checks, runtime.principal());
                if (state.blocked_on === "no_property_selected") {
                    state.properties = await propertiesToOffer(runtime);
                }
                return JSON.stringify(state, null, 2);
            }
            return result.markdown;
        }
        case "report":
            return output(await runReport(runtime, {
                report: requirePositional(positional, "report overview"),
                property_id: str(flags, "property"),
                date_range: str(flags, "range"),
                start_date: str(flags, "start"),
                end_date: str(flags, "end"),
                limit: num(flags, "limit"),
                filter_contains: str(flags, "filter"),
            }), json);
        case "compare":
            return output(await runCompare(runtime, {
                report: requirePositional(positional, "compare overview"),
                property_id: str(flags, "property"),
                date_range: str(flags, "range"),
                limit: num(flags, "limit"),
            }), json);
        case "live":
            return output(await runRealtime(runtime, {
                breakdown: positional[0],
                property_id: str(flags, "property"),
                limit: num(flags, "limit"),
            }), json);
        case "query":
            return output(await runQuery(runtime, {
                metrics: csv(flags, "metrics") ?? [],
                dimensions: csv(flags, "dimensions"),
                property_id: str(flags, "property"),
                date_range: str(flags, "range"),
                start_date: str(flags, "start"),
                end_date: str(flags, "end"),
                filters: filterFlag(flags),
                order_by: str(flags, "sort"),
                limit: num(flags, "limit"),
            }), json);
        case "fields":
            return output(await runFields(runtime, {
                query: requirePositional(positional, "fields sessions"),
                kind: kindFlag(flags),
                property_id: str(flags, "property"),
            }), json);
        case "properties":
            return output(await runProperties(runtime, {}), json);
        default:
            // Unreachable: parseArgs validates command against COMMANDS before
            // returning a "command" result. Kept so the switch satisfies the
            // compiler's control-flow analysis rather than assuming it.
            throw new Error(`internal error: unhandled command ${JSON.stringify(command)}`);
    }
}
