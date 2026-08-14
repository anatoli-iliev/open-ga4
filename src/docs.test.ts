import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { configSchema } from "./config.js";
import { TOOL_NAMES } from "./index.js";
import { PRESETS } from "./ga4/presets.js";
import { ALLOWED_HOSTS } from "./ga4/http.js";

/**
 * Documentation is part of the product here, and a false sentence in it costs
 * more than a bug. These tests keep the prose honest mechanically: a config
 * example that the schema would reject, a tool that does not exist, or a host
 * that is not on the allowlist all fail the build.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "SETUP.md", "PRIVACY.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"];

async function readDocs(): Promise<Array<{ file: string; text: string }>> {
  return Promise.all(
    DOCS.map(async (file) => ({ file, text: await readFile(path.join(repoRoot, file), "utf8") })),
  );
}

function jsonBlocks(text: string): Array<{ line: number; body: string }> {
  const blocks: Array<{ line: number; body: string }> = [];
  for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    blocks.push({
      line: text.slice(0, match.index).split("\n").length,
      body: match[1]!,
    });
  }
  return blocks;
}

describe("documented JSON", () => {
  it("parses", async () => {
    const broken: string[] = [];
    for (const { file, text } of await readDocs()) {
      for (const block of jsonBlocks(text)) {
        try {
          JSON.parse(block.body);
        } catch (error) {
          broken.push(`${file}:${block.line} — ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("would be accepted by the plugin's own config schema", async () => {
    const rejected: string[] = [];

    for (const { file, text } of await readDocs()) {
      for (const block of jsonBlocks(text)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block.body);
        } catch {
          continue; // covered by the test above
        }
        const config = (
          parsed as { plugins?: { entries?: { ga4?: { config?: unknown } } } }
        )?.plugins?.entries?.ga4?.config;
        if (config === undefined) {
          continue;
        }
        if (!Value.Check(configSchema, config)) {
          // typebox 1.3 reports `instancePath`; there is no `path` field.
          const problems = [...Value.Errors(configSchema, config)]
            .map((issue) => `${issue.instancePath || "(root)"}: ${issue.message}`)
            .join("; ");
          rejected.push(`${file}:${block.line} — ${problems}`);
        }
      }
    }

    expect(rejected).toEqual([]);
  });
});

describe("documented identifiers", () => {
  it("names no ga4_ tool that does not exist", async () => {
    const known = new Set<string>(TOOL_NAMES);
    const offenders: string[] = [];
    for (const { file, text } of await readDocs()) {
      for (const match of text.matchAll(/\bga4_[a-z_]+\b/g)) {
        if (!known.has(match[0])) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("names no preset that does not exist", async () => {
    const known = new Set(PRESETS.map((preset) => preset.id));
    // Only check inside backticks, so ordinary prose is not misread as an id.
    const offenders: string[] = [];
    for (const { file, text } of await readDocs()) {
      for (const match of text.matchAll(/`([a-z][a-z0-9_]{3,})`/g)) {
        const token = match[1]!;
        if (/_/.test(token) && !known.has(token) && /^(top|landing|traffic|new|key|sales|daily|search)_/.test(token)) {
          offenders.push(`${file}: ${token}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("names no googleapis host outside the allowlist", async () => {
    const allowed = new Set<string>([
      ...ALLOWED_HOSTS,
      "www.googleapis.com", // appears only inside the OAuth scope identifier
      // Hosts named in SECURITY.md as examples of what the allowlist *rejects*.
      // Listing them here keeps the check strict for everything else.
      "notanalyticsdata.googleapis.com",
      "gmail.googleapis.com",
    ]);
    const offenders: string[] = [];
    for (const { file, text } of await readDocs()) {
      for (const match of text.matchAll(/\b([a-z0-9-]+\.googleapis\.com)\b/gi)) {
        const host = match[1]!.toLowerCase();
        if (!allowed.has(host)) {
          offenders.push(`${file}: ${host}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("references only npm scripts that exist", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const offenders: string[] = [];
    for (const { file, text } of await readDocs()) {
      for (const match of text.matchAll(/\bnpm run ([a-z][a-z:-]*)/g)) {
        if (!pkg.scripts[match[1]!]) {
          offenders.push(`${file}: npm run ${match[1]}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe("the privacy documentation", () => {
  it("lists every host the plugin may contact", async () => {
    const privacy = await readFile(path.join(repoRoot, "PRIVACY.md"), "utf8");
    for (const host of ALLOWED_HOSTS) {
      expect(privacy, `PRIVACY.md should name ${host}`).toContain(host);
    }
  });

  it("states the limit that the user's own model provider still sees the data", async () => {
    const privacy = await readFile(path.join(repoRoot, "PRIVACY.md"), "utf8");
    expect(privacy).toMatch(/model provider|LLM provider/i);
  });
});
