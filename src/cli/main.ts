import { configFromEnv } from "../config.js";
import { diagnose } from "../ga4/errors.js";
import { FILTER_OPERATORS, type FilterCondition, type FilterOperator } from "../ga4/filters.js";
import { redactText } from "../privacy/redact.js";
import { createRuntime, type Ga4Runtime } from "../runtime.js";
import { runCompare, runQuery, runRealtime, runReport } from "../tools/reports.js";
import { runDiagnose, runFields, runProperties } from "../tools/discovery.js";
import { parseArgs, UsageError, type ParsedArgs } from "./args.js";
import { EXIT, exitCodeFor } from "./exit.js";
import type { Streams } from "./render.js";

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
country:exact:US). Only the first two colons matter, so a value may contain
its own, as in pageLocation:contains:https://example.com/checkout. Operators:
${FILTER_OPERATORS.join(", ")}.

Run a command with --help for its options.
Settings live in the environment; see SKILL.md.
`;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  streams: Streams,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    streams.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.BAD_INPUT;
  }

  if (parsed.kind === "help") { streams.out(USAGE); return EXIT.OK; }
  if (parsed.kind === "version") { streams.out(`${VERSION}\n`); return EXIT.OK; }

  const warnings: string[] = [];
  const config = configFromEnv(env, (m) => warnings.push(m));
  const runtime = createRuntime({ config, env, onWarning: (m) => warnings.push(m) });

  try {
    const result = await dispatch(runtime, parsed, env);
    for (const warning of warnings) streams.err(`warning: ${warning}\n`);
    streams.out(result.endsWith("\n") ? result : `${result}\n`);
    return EXIT.OK;
  } catch (error) {
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

/** The "command" branch of ParsedArgs, narrowed once so every reader below can use it directly. */
export type CommandArgs = Extract<ParsedArgs, { kind: "command" }>;
type Flags = CommandArgs["flags"];

/** A flag's raw value, or undefined if it was not given. Every flag this CLI
 * defines takes a value, so one given bare (`--property` with nothing after
 * it) is a mistake worth naming rather than silently coercing. */
function str(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new UsageError(`--${name} needs a value.`);
  }
  return value;
}

/** A flag's value as a number. Number(true) is 1, so a bare boolean flag must
 * be rejected explicitly rather than silently read as a limit of 1. */
function num(flags: Flags, name: string): number | undefined {
  const raw = str(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${name} must be a number; ${JSON.stringify(raw)} is not one.`);
  }
  return value;
}

/** A flag's value split on commas, trimmed, empty entries dropped. */
function csv(flags: Flags, name: string): string[] | undefined {
  const raw = str(flags, name);
  if (raw === undefined) return undefined;
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

const FIELD_KINDS = ["any", "dimension", "metric"] as const;

function kindFlag(flags: Flags): "any" | "dimension" | "metric" | undefined {
  const raw = str(flags, "kind");
  if (raw === undefined) return undefined;
  if (!(FIELD_KINDS as readonly string[]).includes(raw)) {
    throw new UsageError(`--kind must be one of ${FIELD_KINDS.join(", ")}; got ${JSON.stringify(raw)}.`);
  }
  return raw as (typeof FIELD_KINDS)[number];
}

/**
 * query's --filter is one condition, `field:operator:value` (for example
 * `country:exact:US`). Only the first two colons are significant: field is
 * everything before the first, operator is everything between the first and
 * second, and value is everything after the second, colons and all. This
 * matters because pageLocation and pageReferrer are full URLs, and filtering
 * on one (`pageLocation:contains:https://example.com/checkout`) is ordinary,
 * not an edge case; truncating the value at its own colon would silently
 * misread the request rather than raise.
 *
 * A field or an operator cannot themselves contain a colon (there is no
 * legitimate reason for either to), so a missing colon still raises, and the
 * operator is checked against FILTER_OPERATORS here rather than left for
 * buildFilters downstream, so a typo like `a:b:c:d` is rejected for the real
 * reason, an unknown operator (`b`), naming the valid ones, rather than a
 * generic "too many segments" that does not exist as a concept once the value
 * itself is unbounded.
 */
function filterFlag(flags: Flags): FilterCondition[] | undefined {
  const raw = str(flags, "filter");
  if (raw === undefined) return undefined;
  const first = raw.indexOf(":");
  const second = first === -1 ? -1 : raw.indexOf(":", first + 1);
  const field = first === -1 ? "" : raw.slice(0, first);
  const op = second === -1 ? "" : raw.slice(first + 1, second);

  if (field === "" || !(FILTER_OPERATORS as readonly string[]).includes(op)) {
    throw new UsageError(
      `--filter must look like field:operator:value (got ${JSON.stringify(raw)}). Operators: ` +
        `${FILTER_OPERATORS.join(", ")}.`,
    );
  }
  return [{ field, op: op as FilterOperator, value: raw.slice(second + 1) }];
}

/** The first positional argument, or a UsageError pointing at a worked example. */
function requirePositional(positional: string[], example: string): string {
  const value = positional[0];
  if (!value) {
    throw new UsageError(`Missing argument. For example: ${example}`);
  }
  return value;
}

/**
 * Converts each command's flags into the operation's own parameter object and
 * returns its markdown. Kept in this file, not split out: this mapping is
 * what a reviewer most needs to see in one place.
 */
export async function dispatch(runtime: Ga4Runtime, parsed: CommandArgs, _env: NodeJS.ProcessEnv): Promise<string> {
  const { command, positional, flags } = parsed;
  switch (command) {
    case "doctor":
      return (await runDiagnose(runtime, {})).markdown;
    case "report":
      return (await runReport(runtime, {
        report: requirePositional(positional, "report overview"),
        property_id: str(flags, "property"),
        date_range: str(flags, "range"),
        start_date: str(flags, "start"),
        end_date: str(flags, "end"),
        limit: num(flags, "limit"),
        filter_contains: str(flags, "filter"),
      })).markdown;
    case "compare":
      return (await runCompare(runtime, {
        report: requirePositional(positional, "compare overview"),
        property_id: str(flags, "property"),
        date_range: str(flags, "range"),
        limit: num(flags, "limit"),
      })).markdown;
    case "live":
      return (await runRealtime(runtime, {
        breakdown: positional[0],
        property_id: str(flags, "property"),
        limit: num(flags, "limit"),
      })).markdown;
    case "query":
      return (await runQuery(runtime, {
        metrics: csv(flags, "metrics") ?? [],
        dimensions: csv(flags, "dimensions"),
        property_id: str(flags, "property"),
        date_range: str(flags, "range"),
        start_date: str(flags, "start"),
        end_date: str(flags, "end"),
        filters: filterFlag(flags),
        order_by: str(flags, "sort"),
        limit: num(flags, "limit"),
      })).markdown;
    case "fields":
      return (await runFields(runtime, {
        query: requirePositional(positional, "fields sessions"),
        kind: kindFlag(flags),
        property_id: str(flags, "property"),
      })).markdown;
    case "properties":
      return (await runProperties(runtime, {})).markdown;
    default:
      // Unreachable: parseArgs validates command against COMMANDS before
      // returning a "command" result. Kept so the switch satisfies the
      // compiler's control-flow analysis rather than assuming it.
      throw new Error(`internal error: unhandled command ${JSON.stringify(command)}`);
  }
}
