import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "../config.js";
import type { Ga4Client, RunReportResponse } from "../ga4/client.js";
import { normalizePropertyId } from "../privacy/policy.js";
import type { Ga4Runtime } from "../runtime.js";
import { COMMANDS, KNOWN_FLAGS } from "./args.js";
import { EXIT } from "./exit.js";
import { dispatch, main, VERSION, type CommandArgs } from "./main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, streams: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
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
});

describe("client-side validation exits 2, not 1 or 4", () => {
  // These are caught before any network call (findPreset is a local lookup),
  // so they must read as "bad input, name the value, do not retry with a
  // guess" (exit 2), never as "Google refused" (exit 4) or "something
  // unexpected broke" (exit 1). Before this fix they threw a plain Error,
  // which diagnose() could only classify as "UNEXPECTED", and exitCodeFor
  // maps that to exit 4.
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
    const c = capture();
    // "overview" is metrics-only; report presets are covered by
    // reports.test.ts, this only needs one with no dimension to filter.
    // --property is required so the check under test (no dimension to filter
    // on) is what actually fails, rather than property resolution failing
    // first with no credentials configured.
    const code = await main(
      ["report", "overview", "--filter", "checkout", "--property", "123456789"],
      {},
      c.streams,
    );
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("overview");
  });
});

describe("query's --filter grammar: field:operator:value", () => {
  it("accepts a well-formed expression", async () => {
    const c = capture();
    const code = await main(
      ["query", "--metrics", "activeUsers", "--filter", "country:exact:US", "--property", "123456789"],
      {},
      c.streams,
    );
    // A well-formed filter is never rejected as malformed. What fails next
    // (no credentials configured, in this test) has nothing to do with
    // --filter's syntax.
    expect(code).toBe(EXIT.SETUP_INCOMPLETE);
    expect(c.err.join("")).not.toContain("field:operator:value");
  });

  it("exits 2 naming an unknown operator", async () => {
    const c = capture();
    const code = await main(
      ["query", "--metrics", "activeUsers", "--filter", "country:frobnicate:US", "--property", "123456789"],
      {},
      c.streams,
    );
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("frobnicate");
  });

  it("exits 2 on too few segments", async () => {
    const c = capture();
    const code = await main(["query", "--metrics", "activeUsers", "--filter", "country"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("field:operator:value");
  });

  it("exits 2 on too many segments", async () => {
    const c = capture();
    const code = await main(["query", "--metrics", "activeUsers", "--filter", "a:b:c:d"], {}, c.streams);
    expect(code).toBe(EXIT.BAD_INPUT);
    expect(c.err.join("")).toContain("field:operator:value");
  });

  it("exits 2 on an empty segment", async () => {
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

/**
 * A minimal Ga4Runtime that lets every command's happy path get far enough
 * for dispatch to build its parameter object and call the operation, without
 * a real credential or network access. Modeled on the stubRuntime helpers in
 * src/tools/reports.test.ts and src/tools/discovery.test.ts.
 */
function fakeRuntime(): Ga4Runtime {
  const config = configFromEnv({ GA4_PROPERTY_ID: "123456789" });
  const response: RunReportResponse = {
    dimensionHeaders: [{ name: "pagePath" }],
    metricHeaders: [{ name: "activeUsers", type: "TYPE_INTEGER" }],
    rows: [{ dimensionValues: [{ value: "/x" }], metricValues: [{ value: "1" }] }],
    rowCount: 1,
  };
  const client = {
    runReport: async () => response,
    runRealtimeReport: async () => response,
    getMetadata: async () => ({ dimensions: [], metrics: [] }),
    listAccountSummaries: async () => [],
  } as unknown as Ga4Client;

  return {
    config,
    audit: { record: async () => {} },
    client: async () => client,
    principal: () => "reader@example.iam.gserviceaccount.com",
    probes: () => [{ label: "GA4_CREDENTIALS", path: "env", status: "used" }],
    resolveProperty: (explicit) => normalizePropertyId(explicit ?? config.defaultPropertyId!),
    metadata: async () => ({ dimensions: [], metrics: [] }),
    userScopedCustomDimensions: async () => new Set<string>(),
  };
}

describe("every KNOWN_FLAGS entry reaches a real field", () => {
  // "json" is a deliberate exception: it selects markdown vs JSON output in
  // main() itself (wired up in a later task), not a field on any operation's
  // parameter type, so dispatch never reads it directly. Every other flag
  // KNOWN_FLAGS lists for a command must be read while building that
  // command's parameters, or it is exactly the "parses successfully and is
  // then silently dropped" defect README.md calls out in a competing tool.
  const EXEMPT = new Set(["json"]);

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
        await dispatch(fakeRuntime(), parsed, {});
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
