import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "../config.js";
import type { Ga4Client, RunReportRequest, RunReportResponse } from "../ga4/client.js";
import { diagnose } from "../ga4/errors.js";
import { normalizePropertyId } from "../privacy/policy.js";
import type { Ga4Runtime } from "../runtime.js";
import { COMMANDS, KNOWN_FLAGS, UsageError } from "./args.js";
import { EXIT, exitCodeFor } from "./exit.js";
import { dispatch, main, VERSION, type CommandArgs } from "./main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, streams: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

type Recorded = { propertyId: string; request: RunReportRequest };

/**
 * A Ga4Runtime that never touches disk or the network: `client()`, `metadata()`
 * and `userScopedCustomDimensions()` are all hand-written stubs, not the real
 * implementations in src/runtime.ts, so nothing here can reach a real
 * credential file or a real Google request no matter what is installed on the
 * machine running the test. Modeled on the stubRuntime helpers already in
 * src/tools/reports.test.ts and src/tools/discovery.test.ts. `calls` records
 * every request built, so a test can inspect exactly what was sent rather than
 * only whether something threw.
 */
function fakeRuntime(): { runtime: Ga4Runtime; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const config = configFromEnv({ GA4_PROPERTY_ID: "123456789" });
  const response: RunReportResponse = {
    dimensionHeaders: [{ name: "pagePath" }],
    metricHeaders: [{ name: "activeUsers", type: "TYPE_INTEGER" }],
    rows: [{ dimensionValues: [{ value: "/x" }], metricValues: [{ value: "1" }] }],
    rowCount: 1,
  };
  const client = {
    runReport: async (propertyId: string, request: RunReportRequest) => {
      calls.push({ propertyId, request });
      return response;
    },
    runRealtimeReport: async (propertyId: string, request: RunReportRequest) => {
      calls.push({ propertyId, request });
      return response;
    },
    getMetadata: async () => ({ dimensions: [], metrics: [] }),
    listAccountSummaries: async () => [],
  } as unknown as Ga4Client;

  const runtime: Ga4Runtime = {
    config,
    audit: { record: async () => {} },
    client: async () => client,
    principal: () => "reader@example.iam.gserviceaccount.com",
    probes: () => [{ label: "GA4_CREDENTIALS", path: "env", status: "used" }],
    resolveProperty: (explicit) => normalizePropertyId(explicit ?? config.defaultPropertyId!),
    metadata: async () => ({ dimensions: [], metrics: [] }),
    userScopedCustomDimensions: async () => new Set<string>(),
  };

  return { runtime, calls };
}

/**
 * Runs dispatch against a fakeRuntime() and reduces the outcome to an exit
 * code the same way main()'s own catch block does. Used instead of main()
 * itself whenever a test needs to get past property resolution: main() builds
 * its runtime from real credential resolution (src/auth/credentials.ts falls
 * back to the real home directory regardless of the env object a test passes
 * in), so any test driving main() with a valid --property reaches
 * runtime.client() and, on a machine with real Google Application Default
 * Credentials on disk, makes a real network request. dispatch() with
 * fakeRuntime() cannot do that: none of its methods ever resolve a real
 * credential.
 */
async function dispatchExitCode(parsed: CommandArgs): Promise<{ code: number; err: string }> {
  const { runtime } = fakeRuntime();
  try {
    await dispatch(runtime, parsed, {});
    return { code: EXIT.OK, err: "" };
  } catch (error) {
    if (error instanceof UsageError) {
      return { code: EXIT.BAD_INPUT, err: error.message };
    }
    const named = diagnose(error);
    return { code: exitCodeFor(named), err: named.toString() };
  }
}

describe("main", () => {
  it("prints usage and exits 0 for --help", async () => {
    const c = capture();
    expect(await main(["--help"], {}, c.streams)).toBe(0);
    expect(c.out.join("")).toContain("open-ga4");
    expect(c.err.join("")).toBe("");
  });

  it("exits 2 and names the offending option", async () => {
    const c = capture();
    expect(await main(["report", "overview", "--lmit", "5"], {}, c.streams)).toBe(2);
    expect(c.err.join("")).toContain("--lmit");
    expect(c.out.join("")).toBe("");
  });

  it("exits 3 with no credentials configured", async () => {
    const c = capture();
    expect(await main(["report", "overview"], {}, c.streams)).toBe(3);
    expect(c.err.join("")).toMatch(/credential/i);
  });

  it("never prints a stack trace", async () => {
    const c = capture();
    await main(["report", "overview"], {}, c.streams);
    expect(c.err.join("")).not.toContain("    at ");
  });

  it("lists every command in --help", async () => {
    const c = capture();
    await main(["--help"], {}, c.streams);
    for (const command of ["doctor", "report", "compare", "live", "query", "fields", "properties"]) {
      expect(c.out.join("")).toContain(command);
    }
  });

  it("doctor --json exits 0 even though setup is incomplete: it succeeded at diagnosing", async () => {
    // Runs through main() itself, not dispatch()+fakeRuntime(), specifically
    // to exercise real credential resolution finding nothing: with no
    // GA4_CREDENTIALS, no GOOGLE_APPLICATION_CREDENTIALS, and (on the machine
    // this suite runs on) no real gcloud ADC file either, this deterministically
    // reaches the no-credentials branch rather than a real Google request.
    const c = capture();
    const code = await main(["doctor", "--json"], {}, c.streams);
    expect(code).toBe(0);
    expect(c.err.join("")).toBe("");
    const state = JSON.parse(c.out.join("")) as { ok: boolean; blocked_on: string };
    expect(state.ok).toBe(false);
    expect(state.blocked_on).toBe("no_credentials");
  });
});

describe("--json", () => {
  it("doctor --json returns setupStateFrom's shape, not the markdown checklist", async () => {
    const { runtime } = fakeRuntime();
    const parsed: CommandArgs = { kind: "command", command: "doctor", positional: [], flags: { json: true } };
    const result = await dispatch(runtime, parsed, {});
    const state = JSON.parse(result) as { ok: boolean; blocked_on: string; principal?: string };
    expect(state).toEqual({ ok: true, blocked_on: "ok", principal: "reader@example.iam.gserviceaccount.com" });
  });

  it("doctor without --json still returns the markdown checklist", async () => {
    const { runtime } = fakeRuntime();
    const parsed: CommandArgs = { kind: "command", command: "doctor", positional: [], flags: {} };
    const result = await dispatch(runtime, parsed, {});
    expect(result).toMatch(/^## GA4 setup check/);
  });

  it("properties --json returns the operation's structured details", async () => {
    const { runtime } = fakeRuntime();
    const parsed: CommandArgs = { kind: "command", command: "properties", positional: [], flags: { json: true } };
    const result = await dispatch(runtime, parsed, {});
    expect(JSON.parse(result)).toEqual({ properties: [] });
  });

  it("report --json returns structured details instead of a markdown table", async () => {
    const { runtime } = fakeRuntime();
    const parsed: CommandArgs = {
      kind: "command",
      command: "report",
      positional: ["overview"],
      flags: { json: true, property: "123456789" },
    };
    const result = await dispatch(runtime, parsed, {});
    const details = JSON.parse(result) as { propertyId: string };
    expect(details.propertyId).toBe("123456789");
    expect(result).not.toContain("|");
  });
});

describe("client-side validation exits 2, not 1 or 4", () => {
  // These are caught before any network call (findPreset is a local lookup),
  // so they must read as "bad input, name the value, do not retry with a
  // guess" (exit 2), never as "Google refused" (exit 4) or "something
  // unexpected broke" (exit 1). Before this fix they threw a plain Error,
  // which diagnose() could only classify as "UNEXPECTED", and exitCodeFor
  // maps that to exit 4.
  //
  // The first three below run through main() itself: each fails inside
  // findPreset, before runtime.resolveProperty is ever called, so none of
  // them can reach runtime.client() regardless of what credentials the
  // machine running the test happens to have. The fourth needs a property to
  // resolve successfully to reach the check under test, which would then
  // reach runtime.client() through userScopedCustomDimensions if driven
  // through main()'s real runtime, so it uses dispatch() with fakeRuntime()
  // instead, exactly to avoid that.
  it("names an unknown preset on report and exits 2", async () => {
    const c = capture();
    const code = await main(["report", "not_a_real_preset"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("not_a_real_preset");
  });

  it("names an unknown preset on compare and exits 2", async () => {
    const c = capture();
    const code = await main(["compare", "not_a_real_preset"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("not_a_real_preset");
  });

  it("names an unknown realtime breakdown on live and exits 2", async () => {
    const c = capture();
    const code = await main(["live", "not_a_real_breakdown"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("not_a_real_breakdown");
  });

  it("names a report with no dimension to filter on and exits 2", async () => {
    // "overview" is metrics-only; report presets are covered by
    // reports.test.ts, this only needs one with no dimension to filter.
    const parsed: CommandArgs = {
      kind: "command",
      command: "report",
      positional: ["overview"],
      flags: { filter: "checkout", property: "123456789" },
    };
    const { code, err } = await dispatchExitCode(parsed);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(err).toContain("overview");
  });
});

describe("query's --filter grammar: field:operator:value", () => {
  it("accepts a well-formed expression", async () => {
    // Runs through dispatch() with fakeRuntime(), not main(): fakeRuntime()
    // always succeeds, so this asserts the stronger and fully
    // network-independent claim that a well-formed filter completes exit 0,
    // rather than the weaker "not exit 2" a real main() run would be limited
    // to (main()'s runtime resolves real credentials regardless of the env
    // object a test passes in, so driving this scenario through main() with
    // a --property that resolves can still reach runtime.client() and, on a
    // machine with real Google Application Default Credentials on disk,
    // issue a real request).
    const parsed: CommandArgs = {
      kind: "command",
      command: "query",
      positional: [],
      flags: { metrics: "activeUsers", filter: "country:exact:US", property: "123456789" },
    };
    const { code, err } = await dispatchExitCode(parsed);
    expect(code).toBe(EXIT.OK);
    expect(err).toBe("");
  });

  it("keeps a value's own colon intact, as in a URL", async () => {
    // pageLocation and pageReferrer are full URLs; filtering on one is
    // ordinary, not an edge case. Runs through dispatch() with fakeRuntime()
    // (not main()) specifically so the built request can be inspected
    // directly, rather than inferring correctness from an exit code.
    const { runtime, calls } = fakeRuntime();
    const parsed: CommandArgs = {
      kind: "command",
      command: "query",
      positional: [],
      flags: {
        metrics: "activeUsers",
        filter: "pageLocation:contains:https://example.com/checkout",
        property: "123456789",
      },
    };
    await dispatch(runtime, parsed, {});
    expect(calls[0]!.request.dimensionFilter).toEqual({
      filter: {
        fieldName: "pageLocation",
        stringFilter: { matchType: "CONTAINS", value: "https://example.com/checkout", caseSensitive: false },
      },
    });
  });

  it("exits 2 naming an unknown operator", async () => {
    const parsed: CommandArgs = {
      kind: "command",
      command: "query",
      positional: [],
      flags: { metrics: "activeUsers", filter: "country:frobnicate:US", property: "123456789" },
    };
    const { code, err } = await dispatchExitCode(parsed);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(err).toContain("frobnicate");
  });

  it("exits 2 with no colon at all", async () => {
    const c = capture();
    const code = await main(["query", "--metrics", "activeUsers", "--filter", "country"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("field:operator:value");
  });

  it("exits 2 on an empty field", async () => {
    const c = capture();
    const code = await main(["query", "--metrics", "activeUsers", "--filter", ":exact:US"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("field:operator:value");
  });

  it("exits 2 on an empty operator", async () => {
    const c = capture();
    const code = await main(["query", "--metrics", "activeUsers", "--filter", "country::US"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("field:operator:value");
  });
});

describe("VERSION", () => {
  it("matches package.json, so the two cannot drift", () => {
    // VERSION is a string literal, not a runtime read of package.json: the
    // file is not shipped inside the skill bundle, so reading it at runtime
    // would work in this checkout and fail after install. This test is what
    // keeps the literal honest instead.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("every KNOWN_FLAGS entry reaches a real field", () => {
  // "json" used to be a deliberate exception here: it selects markdown vs
  // JSON output rather than landing on a field of any operation's parameter
  // type. It no longer needs the exemption, because dispatch now reads
  // flags.json directly (unconditionally, before the switch) to make that
  // selection, so the Proxy below records it as accessed like any other
  // flag. Every flag KNOWN_FLAGS lists for a command must be read while
  // dispatch handles that command, or it is exactly the "parses successfully
  // and is then silently dropped" defect README.md calls out in a competing
  // tool.
  const EXEMPT = new Set<string>();

  const EXAMPLE: Record<string, string> = {
    property: "123456789",
    range: "last 7 days",
    start: "2024-01-01",
    end: "2024-01-31",
    limit: "5",
    sort: "activeUsers",
    dimensions: "country",
    metrics: "activeUsers",
    kind: "any",
  };

  // --filter's own grammar differs by command (see the USAGE string and
  // filterFlag's doc comment in main.ts), so it needs a command-aware example.
  function exampleValue(command: string, flag: string): string {
    if (flag === "filter") return command === "query" ? "country:exact:US" : "checkout";
    return EXAMPLE[flag] ?? "x";
  }

  const POSITIONAL: Record<string, string[]> = {
    doctor: [],
    report: ["overview"],
    compare: ["overview"],
    live: ["realtime_now"],
    query: [],
    fields: ["sessions"],
    properties: [],
  };

  for (const command of COMMANDS) {
    it(`${command}: every declared flag is read by dispatch`, async () => {
      const declared = KNOWN_FLAGS[command] ?? [];
      const checked = declared.filter((flag) => !EXEMPT.has(flag));

      const accessed = new Set<string>();
      const base: Record<string, string | boolean> = {};
      for (const flag of declared) base[flag] = exampleValue(command, flag);
      const flags = new Proxy(base, {
        get(target, prop, receiver) {
          if (typeof prop === "string") accessed.add(prop);
          return Reflect.get(target, prop, receiver);
        },
      });

      const parsed: CommandArgs = {
        kind: "command",
        command,
        positional: POSITIONAL[command] ?? [],
        flags,
      };

      try {
        const { runtime } = fakeRuntime();
        await dispatch(runtime, parsed, {});
      } catch {
        // Only whether each flag was *read* while building the parameter
        // object matters here; a fake network or an unmatched preset id
        // failing past that point is somebody else's test (reports.test.ts,
        // discovery.test.ts).
      }

      for (const flag of checked) {
        expect([...accessed], `--${flag} on "${command}" must be read by dispatch`).toContain(flag);
      }
    });
  }
});
