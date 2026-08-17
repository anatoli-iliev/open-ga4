import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRESETS } from "./ga4/presets.js";
import { ALLOWED_HOSTS } from "./ga4/http.js";
import {
  environmentVariablesRead,
  listFiles,
  readShippedDocs,
  repoRoot,
  SHIPPED_DOCS,
  shippedSources,
} from "./testing/files.test-support.js";

/**
 * Documentation is part of the product here, and a false sentence in it costs
 * more than a bug. These tests keep the prose honest mechanically: a preset
 * that does not exist, or a host that is not on the allowlist, fails the
 * build.
 *
 * Two checks that used to live here died with the plugin: a
 * `plugins.entries.ga4.config` example validated against the plugin's config
 * schema, and a `ga4_` tool name checked against the registered tool list.
 * Their skill-shaped replacements are below (no `plugins.entries` anywhere
 * that ships, and every documented environment variable is one the code
 * reads); the command names moved to `src/docs/skill.test.ts`, which checks
 * them by parsing every quoted command rather than by matching a prefix.
 */

const DOCS = [...SHIPPED_DOCS];

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
          broken.push(`${file}:${block.line}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("documented identifiers", () => {
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

describe("project identity", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string;
    repository: { url: string };
    homepage: string;
    bugs: { url: string };
    license: string;
  };

  it("is named open-ga4", () => {
    expect(pkg.name).toBe("open-ga4");
  });

  it("points every url at the open-ga4 repository", () => {
    for (const url of [pkg.repository.url, pkg.homepage, pkg.bugs.url]) {
      expect(url).toContain("anatoli-iliev/open-ga4");
      expect(url).not.toContain("openclaw-plugin-ga4");
    }
  });

  it("is licensed MIT-0", () => {
    expect(pkg.license).toBe("MIT-0");
    expect(readFileSync("LICENSE", "utf8")).toContain("MIT No Attribution");
  });

  it("mentions the old name nowhere in shipped documentation", () => {
    for (const { file, text } of readShippedDocs()) {
      expect(text, `${file} still names the old repository`).not.toContain("openclaw-plugin-ga4");
    }
  });
});

/**
 * How many packages this project installs at runtime, from the manifest rather
 * than from a sentence somebody wrote once.
 */
function runtimeDependencyCount(): number {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.peerDependencies ?? {}).length;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  no: 0,
  none: 0,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
};

/**
 * Every "<count> runtime dependencies" claim in a document, in either word
 * order: "zero runtime dependencies" and "runtime dependencies: none" are the
 * same claim and both have been written here.
 *
 * Only number words and digits match, so "the runtime dependency policy" and
 * "in dependency order" are not mistaken for claims about a count.
 */
function dependencyCountClaims(text: string): number[] {
  const claims: number[] = [];
  const patterns = [
    /\b([a-z]+|\d+)\s+runtime\s+dependenc(?:y|ies)\b/gi,
    /\bruntime\s+dependenc(?:y|ies)\s*:?\s*\**\s*([a-z]+|\d+)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const word = match[1]!.toLowerCase();
      const value = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
      if (value !== undefined) {
        claims.push(value);
      }
    }
  }
  return claims;
}

describe("runtime dependencies", () => {
  it("ships no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it("imports nothing outside node: builtins", () => {
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      for (const match of readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = match[1]!;
        if (spec.startsWith(".") || spec.startsWith("node:")) {
          continue;
        }
        offenders.push(`${path.relative(repoRoot, file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The count is a headline claim in five documents, and correcting the
  // sentence while leaving the claim beneath it wrong is a mistake this
  // repository has recorded twice. Asserting the number against package.json
  // is what makes a prose-only fix impossible.
  it("states a count that matches package.json wherever it states one", () => {
    const actual = runtimeDependencyCount();
    const wrong: string[] = [];
    for (const { file, text } of readShippedDocs()) {
      for (const claimed of dependencyCountClaims(text)) {
        if (claimed !== actual) {
          wrong.push(`${file} claims ${claimed} runtime dependencies; package.json has ${actual}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("states the count in every document that makes the auditability argument", () => {
    // Not every document needs to mention it, but these five build an argument
    // on it, so silently deleting the claim would leave the argument standing
    // on nothing.
    for (const file of ["README.md", "PRIVACY.md", "SECURITY.md", "CONTRIBUTING.md", "docs/DESIGN.md"]) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      expect(dependencyCountClaims(text).length, `${file} makes no runtime-dependency claim`)
        .toBeGreaterThan(0);
    }
  });
});

describe("no references to the retired plugin config path", () => {
  /**
   * `plugins.entries.ga4.config` named a plugin configuration block that no
   * longer exists now this project is a skill rather than an OpenClaw plugin.
   * A hint that still names it tells a stuck user to edit something that is
   * not there.
   *
   * This sweep covers the shipped source *and* the shipped documentation. It
   * used to cover only the source, which is the half where the string was
   * least likely to survive: the documentation is where a configuration block
   * gets written out in full.
   */
  it("mentions plugins.entries nowhere that ships", () => {
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      if (readFileSync(file, "utf8").includes("plugins.entries")) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    for (const { file, text } of readShippedDocs()) {
      if (text.includes("plugins.entries")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("no references to the retired tool names", () => {
  /**
   * The seven names below, each with a `ga4_` prefix, were tool names under
   * the plugin API. They are commands now, so a message naming one tells a
   * stuck user to run something that does not exist, and an error message is
   * the most load-bearing documentation in the product: it fires at the moment
   * somebody is stuck and has nowhere else to look.
   *
   * Same shape as the plugins.entries sweep above, and for the same reason:
   * closing the class beats fixing the instances. Seven error messages were
   * found by hand once; the eighth would not have been.
   *
   * Scans every `.ts` under `src/`, tests included: a test name or a fixture
   * naming a retired tool is the same drift, and there is no comment here that
   * needs to spell one out.
   */
  const retired = ["report", "compare", "realtime", "query", "fields", "diagnose", "properties"]
    // Assembled rather than written out, so this sweep does not match its own
    // source. Nothing else in this file spells a retired name.
    .map((name) => `ga4_${name}`);

  /**
   * The one occurrence that is not ours. `README.md` cites the query script
   * in `jdrhyne/agent-skills` as a verified fact about that project, with a
   * link to the repository it lives in. It is a path in somebody else's
   * project, quoted as evidence, and rewriting it would make the claim false.
   *
   * Built from `retired` rather than written out, for the same reason as
   * above.
   */
  const FOREIGN_CITATIONS = [`scripts/${retired.find((name) => name.endsWith("query"))!}.py`];

  it("names no retired tool anywhere in src/", () => {
    const offenders: string[] = [];
    for (const file of listFiles(path.join(repoRoot, "src"), ".ts")) {
      const text = readFileSync(file, "utf8");
      for (const name of retired) {
        if (text.includes(name)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no retired tool anywhere in the shipped documentation", () => {
    const offenders: string[] = [];
    for (const { file, text } of readShippedDocs()) {
      let scanned = text;
      for (const citation of FOREIGN_CITATIONS) {
        scanned = scanned.split(citation).join("");
      }
      for (const name of retired) {
        if (scanned.includes(name)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("documented environment variables", () => {
  /**
   * Replaces the deleted check that validated `plugins.entries.ga4.config`
   * examples against the plugin's config schema. A skill has no config schema
   * to validate against; its settings are environment variables, so the
   * equivalent question is whether a variable named in the prose is one the
   * code actually reads.
   *
   * A variable that is documented and not read is worse than an undocumented
   * one: somebody sets it, nothing happens, and there is no error to explain
   * why.
   */
  it("names no GA4_ variable that the code does not read", () => {
    const read = environmentVariablesRead();
    const offenders: string[] = [];
    for (const { file, text } of readShippedDocs()) {
      for (const match of text.matchAll(/\bGA4_[A-Z0-9_]+\b/g)) {
        if (!read.has(match[0])) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("names no other environment variable that the code does not read", () => {
    // Only names in a namespace that actually holds environment variables, so
    // a backticked constant (ALLOWED_HOSTS, PRESETS) or a Google error status
    // (SERVICE_DISABLED, NOT_FOUND) is not mistaken for one.
    const environmentShaped = /^(?:GOOGLE_|OPENCLAW_|XDG_|NPM_)[A-Z0-9_]+$|^(?:NO_COLOR|HOME|USERPROFILE|USERNAME)$/;
    // Named while explaining OpenClaw, the sandbox wrapper or the operating
    // system, rather than as a setting of this skill. Everything else in those
    // namespaces has to be a variable the code reads.
    const notOurs = new Set([
      "OPENCLAW_CONFIG_DIR",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_SANDBOX_DIR",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "HOME",
      "USERPROFILE",
      "USERNAME",
      "NPM_TOKEN",
    ]);
    const read = environmentVariablesRead();
    const offenders: string[] = [];
    for (const { file, text } of readShippedDocs()) {
      for (const match of text.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) {
        const name = match[1]!;
        if (environmentShaped.test(name) && !read.has(name) && !notOurs.has(name)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe("the test helpers", () => {
  it("walks the source tree with a readdirSync recursion, never a glob", () => {
    // Assembled rather than written out, so this scan does not trip over its
    // own source: the name it is looking for would otherwise be in the file
    // doing the looking.
    const banned = ["glob", "Sync("].join("");
    const helper = readFileSync(path.join(repoRoot, "src/testing/files.test-support.ts"), "utf8");
    expect(helper).toContain("readdirSync");
    const offenders: string[] = [];
    for (const file of listFiles(path.join(repoRoot, "src"), ".ts")) {
      if (readFileSync(file, "utf8").includes(banned)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
