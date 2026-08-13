import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural privacy guarantees, asserted against the built artifact rather
 * than against intentions.
 *
 * The Data API has exactly three surfaces that return per-person rows:
 * `properties.audienceExports`, `properties.audienceLists`, and the Admin API's
 * `runAccessReport`. This plugin does not call them. That claim is worth
 * something only if it is checked, so it is checked here — against `dist/`,
 * which is what actually ships to users.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "../../dist");

async function readDistSources(): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".js")) {
        out.push({ file: path.relative(distDir, full), text: await readFile(full, "utf8") });
      }
    }
  }
  await walk(distDir);
  return out;
}

describe("the shipped bundle", () => {
  it("never references a per-user Google Analytics surface", async () => {
    const forbidden = ["audienceExport", "audienceList", "runAccessReport", "userDataRetention"];
    const offenders: string[] = [];

    for (const { file, text } of await readDistSources()) {
      for (const term of forbidden) {
        if (text.includes(term)) {
          offenders.push(`${file} contains "${term}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("requests no OAuth scope other than analytics.readonly", async () => {
    const scopes = new Set<string>();
    for (const { text } of await readDistSources()) {
      for (const match of text.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.-]+/g)) {
        scopes.add(match[0]);
      }
    }
    expect([...scopes]).toEqual(["https://www.googleapis.com/auth/analytics.readonly"]);
  });

  it("contacts no host outside the documented allowlist", async () => {
    const hosts = new Set<string>();
    for (const { text } of await readDistSources()) {
      for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        hosts.add(match[1]!.toLowerCase());
      }
    }
    // www.googleapis.com appears only inside the scope identifier, which is a
    // constant string and never fetched.
    const allowed = new Set([
      "www.googleapis.com",
      "analyticsadmin.googleapis.com",
      "analyticsdata.googleapis.com",
      "oauth2.googleapis.com",
    ]);
    const unexpected = [...hosts].filter((host) => !allowed.has(host));
    expect(unexpected).toEqual([]);
  });

  it("writes nothing to disk outside the audit log", async () => {
    const offenders: string[] = [];
    for (const { file, text } of await readDistSources()) {
      if (file.startsWith("privacy/audit")) {
        continue;
      }
      for (const term of ["writeFile", "appendFile", "createWriteStream", "mkdir"]) {
        if (text.includes(term)) {
          offenders.push(`${file} calls ${term}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
