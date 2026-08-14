import { describe, expect, it, vi } from "vitest";
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
    await logger.record({ tool: "ga4_report", propertyId: "123456789" });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.path).toBe("/tmp/ga4-audit.log");
    expect(lines[0]!.line.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!.line)).toEqual({
      time: "2026-08-14T09:00:00.000Z",
      tool: "ga4_report",
      property: "123456789",
    });
  });

  it("records the question: fields, range and a row count", async () => {
    const { logger, lines } = capture();
    await logger.record({
      tool: "ga4_query",
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
    await logger.record({ tool: "ga4_report", propertyId: "123456789", rows: 3 });

    const entry = JSON.parse(lines[0]!.line) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["property", "rows", "time", "tool"]);
    expect(entry).not.toHaveProperty("values");
    expect(entry).not.toHaveProperty("response");
  });

  it("omits empty field lists rather than logging noise", async () => {
    const { logger, lines } = capture();
    await logger.record({ tool: "ga4_report", propertyId: "1", dimensions: [], metrics: [] });
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

    await expect(logger.record({ tool: "ga4_report", propertyId: "1" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("/nope/audit.log"));
  });
});

describe("NULL_AUDIT_LOGGER", () => {
  it("does nothing, which is the default when no path is configured", async () => {
    await expect(NULL_AUDIT_LOGGER.record({ tool: "x", propertyId: "1" })).resolves.toBeUndefined();
  });
});
