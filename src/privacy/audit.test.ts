import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NULL_AUDIT_LOGGER, createAuditLogger } from "./audit.js";

function capture() {
  const lines: Array<{ path: string; line: string }> = [];
  const logger = createAuditLogger({
    path: "/tmp/ga4-audit.log",
    now: () => new Date("2026-08-14T09:00:00Z"),
    append: async (path, line) => {
      lines.push({ path, line });
    },
  });
  return { logger, lines };
}

describe("createAuditLogger", () => {
  it("writes one JSON line per call, to the configured path", async () => {
    const { logger, lines } = capture();
    await logger.record({ tool: "report", propertyId: "123456789" });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.path).toBe("/tmp/ga4-audit.log");
    expect(lines[0]!.line.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!.line)).toEqual({
      time: "2026-08-14T09:00:00.000Z",
      tool: "report",
      property: "123456789",
    });
  });

  it("records the question: fields, range and a row count", async () => {
    const { logger, lines } = capture();
    await logger.record({
      tool: "query",
      propertyId: "123456789",
      dimensions: ["pagePath"],
      metrics: ["sessions"],
      dateRange: "last 7 days",
      rows: 25,
    });

    expect(JSON.parse(lines[0]!.line)).toMatchObject({
      dimensions: ["pagePath"],
      metrics: ["sessions"],
      dateRange: "last 7 days",
      rows: 25,
    });
  });

  it("records no report values, only a count of them", async () => {
    const { logger, lines } = capture();
    await logger.record({ tool: "report", propertyId: "123456789", rows: 3 });

    const entry = JSON.parse(lines[0]!.line) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["property", "rows", "time", "tool"]);
    expect(entry).not.toHaveProperty("values");
    expect(entry).not.toHaveProperty("response");
  });

  it("omits empty field lists rather than logging noise", async () => {
    const { logger, lines } = capture();
    await logger.record({ tool: "report", propertyId: "1", dimensions: [], metrics: [] });
    expect(JSON.parse(lines[0]!.line)).not.toHaveProperty("dimensions");
  });

  it("keeps working when the log cannot be written", async () => {
    const onError = vi.fn();
    const logger = createAuditLogger({
      path: "/nope/audit.log",
      append: async () => {
        throw new Error("EACCES: permission denied");
      },
      onError,
    });

    await expect(logger.record({ tool: "report", propertyId: "1" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("/nope/audit.log"));
  });
});

/**
 * The default `append`, which is `node:fs/promises` `appendFile`, exercised
 * against a real file in a temporary directory.
 *
 * Every test above injects `append`, which is the right shape for asserting
 * what a line contains but leaves the actual write unexercised. That gap is why
 * a defect in the shipped path went unnoticed for the whole project: the log
 * was configured, enabled and documented, and wrote nothing. src/cli/shim.test.ts
 * covers the other half (an unawaited write surviving process teardown); this
 * covers the write itself.
 */
describe("createAuditLogger with no injected append", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "open-ga4-audit-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file and writes one JSON line to it", async () => {
    const logPath = path.join(dir, "created.log");
    const logger = createAuditLogger({ path: logPath, now: () => new Date("2026-08-14T09:00:00Z") });
    await logger.record({ tool: "query", propertyId: "123456789", rows: 3 });

    expect(JSON.parse(await readFile(logPath, "utf8"))).toEqual({
      time: "2026-08-14T09:00:00.000Z",
      tool: "query",
      property: "123456789",
      rows: 3,
    });
  });

  it("appends to an existing file rather than replacing it", async () => {
    const logPath = path.join(dir, "appended.log");
    const logger = createAuditLogger({ path: logPath });
    await logger.record({ tool: "report", propertyId: "1" });
    await logger.record({ tool: "compare", propertyId: "2" });

    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { tool: string }).tool)).toEqual([
      "report",
      "compare",
    ]);
  });

  it("reports a directory that does not exist instead of throwing", async () => {
    // The real failure mode for a path a user typed: the skill warns and the
    // answer still arrives. Reaches the real errno rather than a thrown stub.
    const onError = vi.fn();
    const logger = createAuditLogger({ path: path.join(dir, "no-such-dir", "audit.log"), onError });

    await expect(logger.record({ tool: "report", propertyId: "1" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("no-such-dir"));
  });
});

describe("NULL_AUDIT_LOGGER", () => {
  it("does nothing, which is the default when no path is configured", async () => {
    await expect(NULL_AUDIT_LOGGER.record({ tool: "x", propertyId: "1" })).resolves.toBeUndefined();
  });
});
