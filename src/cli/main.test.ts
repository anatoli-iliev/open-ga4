import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main, VERSION } from "./main.js";

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
