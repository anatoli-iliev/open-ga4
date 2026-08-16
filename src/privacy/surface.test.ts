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
 * something only if it is checked, so it is checked here, against `dist/`,
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

  it("mentions no URL that is neither contacted nor a documented signpost", async () => {
    // Hosts the plugin actually opens a connection to. The runtime guarantee is
    // enforced by assertAllowedUrl in ga4/http.ts and tested there; this scan is
    // defence in depth against a hardcoded URL reaching the bundle unreviewed.
    const contacted = ["analyticsadmin.googleapis.com", "analyticsdata.googleapis.com", "oauth2.googleapis.com"];

    // Hosts that appear only as text shown to a human: a link in a "here is
    // how to fix it" message, or the OAuth scope identifier. Never fetched.
    // Adding to this list is a deliberate, reviewable decision.
    const referencedOnly = [
      "www.googleapis.com", // inside the analytics.readonly scope string
      "console.cloud.google.com", // "enable the API here" link in errors.ts
      "console.developers.google.com", // same link, as Google returns it in Help details
    ];

    const allowed = new Set([...contacted, ...referencedOnly]);
    const hosts = new Set<string>();
    for (const { text } of await readDistSources()) {
      for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        hosts.add(match[1]!.toLowerCase());
      }
    }

    expect([...hosts].filter((host) => !allowed.has(host))).toEqual([]);
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
