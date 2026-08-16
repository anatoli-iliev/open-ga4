import { describe, expect, it } from "vitest";
import { FORBIDDEN_FLAGS, parseArgs, UsageError } from "./args.js";

/**
 * Narrows the ParsedArgs union so tests can read `.flags` under strict mode.
 * `flags` only exists on the "command" variant; accessing it on the raw
 * union return value is a compile error, not something toThrow/toEqual can
 * paper over.
 */
function flagsOf(parsed: ReturnType<typeof parseArgs>): Record<string, string | boolean> {
  if (parsed.kind !== "command") throw new Error(`expected a command, got ${parsed.kind}`);
  return parsed.flags;
}

describe("parseArgs", () => {
  it("reads a command and its positional argument", () => {
    expect(parseArgs(["report", "top_pages"])).toEqual({
      kind: "command", command: "report", positional: ["top_pages"], flags: {},
    });
  });

  it("accepts hyphens where the preset id uses underscores", () => {
    const parsed = parseArgs(["report", "top-pages"]);
    expect(parsed).toMatchObject({ positional: ["top_pages"] });
  });

  it("reads --flag value and --flag=value identically", () => {
    expect(flagsOf(parseArgs(["report", "overview", "--limit", "5"]))).toEqual({ limit: "5" });
    expect(flagsOf(parseArgs(["report", "overview", "--limit=5"]))).toEqual({ limit: "5" });
  });

  it("treats a bare --flag as true", () => {
    expect(flagsOf(parseArgs(["doctor", "--json"]))).toEqual({ json: true });
  });

  it("rejects an unknown flag by name", () => {
    expect(() => parseArgs(["report", "overview", "--lmit", "5"]))
      .toThrow(/--lmit/);
  });

  it("rejects a flag that would weaken privacy", () => {
    for (const flag of FORBIDDEN_FLAGS) {
      expect(() => parseArgs(["report", "overview", `--${flag}`]))
        .toThrow(/set by a person|environment variable/i);
    }
  });

  it("throws UsageError, never a bare Error", () => {
    expect(() => parseArgs(["nonsense"])).toThrow(UsageError);
  });

  it("understands --help with and without a command", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["report", "--help"])).toEqual({ kind: "help", command: "report" });
  });

  it("stops flag parsing after --", () => {
    expect(parseArgs(["fields", "--", "--weird-field-name"]))
      .toMatchObject({ positional: ["--weird-field-name"] });
  });

  it("normalizes the preset id for report, compare and live", () => {
    // live's positional is a realtime breakdown preset id (RealtimeParams.breakdown
    // in src/tools/reports.ts), the same shape as report's and compare's, so it
    // gets the same hyphen-to-underscore treatment.
    expect(parseArgs(["report", "top-pages"])).toMatchObject({ positional: ["top_pages"] });
    expect(parseArgs(["compare", "top-pages"])).toMatchObject({ positional: ["top_pages"] });
    expect(parseArgs(["live", "realtime-pages"])).toMatchObject({ positional: ["realtime_pages"] });
  });

  it("passes positionals through verbatim for every other command", () => {
    // fields' positional is a free-text search term matched literally against
    // field names and descriptions (runFields / FieldsParams.query); silently
    // rewriting "page-view" to "page_view" would search for the wrong thing
    // and never tell the user.
    expect(parseArgs(["fields", "page-view"])).toMatchObject({ positional: ["page-view"] });
    // A hyphenated, date-like positional must also survive unchanged on a
    // command that isn't report or compare.
    expect(parseArgs(["query", "2024-01-01"])).toMatchObject({ positional: ["2024-01-01"] });
  });
});
