import { existsSync, readFileSync } from "node:fs";
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

/**
 * Every method `src/ga4/client.ts` returns, read from the source rather than
 * listed here. The client is one hand-written object literal, so its methods
 * are the only ones indented four spaces and declared `async`; `guardedFetch`
 * and `call` are module-level functions and do not match.
 */
function clientMethods(): string[] {
  const source = readFileSync(path.join(repoRoot, "src/ga4/client.ts"), "utf8");
  return [...source.matchAll(/^ {4}async (\w+)\(/gm)].map((match) => match[1]!);
}

const COUNT_WORDS: readonly string[] = ["zero", "one", "two", "three", "four", "five", "six", "seven"];

describe("the documented Google API surface", () => {
  /**
   * "The complete Google surface is N read methods: ..." is the load-bearing
   * sentence of this project's security argument, and it is made in two
   * documents. It went stale the moment a method was added or removed:
   * `checkCompatibility` was implemented, never called, and counted in both
   * lists, so a reader auditing the surface would have gone looking for a
   * caller that did not exist.
   *
   * Pinning the rendered list, built from the source, is what makes the next
   * change to the client impossible to land without updating the prose.
   */
  it("lists exactly the methods the client implements, in both documents", () => {
    const methods = clientMethods();
    expect(methods.length, "no methods were found in src/ga4/client.ts").toBeGreaterThan(0);
    const rendered = methods.map((name) => `\`${name}\``).join(", ");

    for (const file of ["PRIVACY.md", "SECURITY.md"]) {
      const text = readFileSync(path.join(repoRoot, file), "utf8").replace(/\s+/g, " ");
      expect(text, `${file} should name the complete surface as ${rendered}`).toContain(rendered);
      expect(text, `${file} should say there are ${COUNT_WORDS[methods.length]} read methods`)
        .toContain(`${COUNT_WORDS[methods.length]} read methods`);
    }
  });

  it("names no method the client does not have, in the documents that claim completeness", () => {
    // The other direction, so a method deleted from the client cannot survive
    // in a sentence somewhere other than the two lists above.
    //
    // Scoped to the two documents that assert what the surface *is*.
    // docs/DESIGN.md is deliberately excluded: it is a design record, and its
    // convention is to say in place what was decided and then reversed, which
    // means naming a retired identifier in the past tense on purpose.
    const implemented = new Set(clientMethods());
    // Method-shaped rather than a fixed list, so a name nobody has invented
    // yet is caught as well as the ones that exist today.
    const methodShaped = /`(\w*(?:Report|Metadata|Compatibility|Summaries|Property|Properties))`/g;
    /**
     * The three method-shaped names in these documents that are deliberately
     * not client methods, each named for a reason the sentence around it
     * depends on:
     *
     * - `accountSummaries` is the Admin API resource the host table names.
     * - `deleteProperty` is the write method that does not exist, named as the
     *   thing a generated SDK could quietly introduce and this one cannot.
     * - `runAccessReport` is one of the three per-visitor endpoints the skill
     *   never calls, named so the claim can be checked.
     */
    const NOT_CLIENT_METHODS = new Set(["accountSummaries", "deleteProperty", "runAccessReport"]);
    const offenders: string[] = [];
    for (const file of ["PRIVACY.md", "SECURITY.md"]) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      for (const match of text.matchAll(methodShaped)) {
        const name = match[1]!;
        // Lower-case first letter: a method name, not a type (RunReportRequest)
        // or a URL path segment (`metadata`, matched by neither).
        if (/^[a-z]/.test(name) && !implemented.has(name) && !NOT_CLIENT_METHODS.has(name)) {
          offenders.push(`${file}: ${name}`);
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
  /**
   * Repository configuration is in scope alongside the documentation, decided
   * rather than assumed. A comment in `dependabot.yml` made this exact claim
   * and outlived the dependency by a whole review cycle, because the first
   * version of this test could only see the six documents. These files are
   * read by contributors and by anyone auditing the supply chain, they are
   * where a stale dependency claim is least likely to be noticed, and scanning
   * two more paths costs nothing.
   */
  const REPOSITORY_CONFIG = [".github/dependabot.yml", ".github/workflows/ci.yml"];

  it("states a count that matches package.json wherever it states one", () => {
    const actual = runtimeDependencyCount();
    const sources = [
      ...readShippedDocs(),
      ...REPOSITORY_CONFIG.map((file) => ({
        file,
        text: readFileSync(path.join(repoRoot, file), "utf8"),
      })),
    ];
    const wrong: string[] = [];
    for (const { file, text } of sources) {
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

describe("no references to this project as a plugin", () => {
  /**
   * Same class as the retired tool names, and it drifts the same way. A user
   * reading "This plugin returns at most 1000 rows" is being told about
   * something that does not exist, by the software itself, in the middle of an
   * error.
   *
   * The shipped source is held to the strict form: the word does not appear at
   * all. Every occurrence there was a self-reference, so there is nothing
   * legitimate to carve out, and a whole-word ban is the version that cannot
   * be argued with.
   */
  it("never calls itself a plugin anywhere in the shipped source", () => {
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      if (/\bplugins?\b/i.test(readFileSync(file, "utf8"))) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The documentation is held to a narrower form, on purpose. These documents
   * discuss the former plugin deliberately and in the past tense: what the
   * plugin registration API could do, what died with the plugin config block,
   * why D1 was reversed. Banning the noun would delete that history, which is
   * the part worth keeping.
   *
   * What is banned is the present-tense self-reference: "this plugin", and
   * "the plugin" followed by a verb in the present tense. Both spellings say
   * that this project *is* a plugin, which is the false claim. "the plugin
   * registration API" and "went away with the plugin" say what it *was*, and
   * survive.
   *
   * The residual gap is deliberate and small: a sentence could still call this
   * a plugin in some phrasing neither pattern matches. That is what review is
   * for; this closes the two shapes it has actually taken.
   */
  const PRESENT_TENSE_SELF_REFERENCE = [
    /\bthis plugin\b/i,
    /\bthe plugin (?:is|are|does|do|ships|implements|returns|may|must|works|calls|reads|writes|uses|has|registers)\b/i,
  ];

  it("never calls itself a plugin in the present tense in shipped documentation", () => {
    const offenders: string[] = [];
    for (const { file, text } of readShippedDocs()) {
      for (const pattern of PRESENT_TENSE_SELF_REFERENCE) {
        const match = pattern.exec(text);
        if (match) {
          offenders.push(`${file}: ${match[0]}`);
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

describe("the committed build output claim", () => {
  /**
   * README.md and SECURITY.md both used to describe `lib/` and the CI drift
   * job in the future tense, because they were written before either
   * existed. That was corrected once already (this exact sentence is what
   * the correction produced), and the failure mode worth guarding against is
   * the claim quietly outliving what it describes: a future revert of
   * `lib/` or the CI job that leaves the assertive prose behind.
   *
   * So this does not just check that the claim is made (that part is
   * pinned by the exact phrase both documents already share); it checks
   * that making the claim is only possible while it stays true. If a change
   * ever deletes `lib/cli.js` or the workflow job without also softening
   * this sentence back to future tense, this is what fails, naming the
   * thing that no longer matches what is claimed.
   */
  const CLAIM = "fails if the committed output differs by a byte";

  it("is made in both README.md and SECURITY.md", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const security = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
    expect(readme).toContain(CLAIM);
    expect(security).toContain(CLAIM);
  });

  it("cannot outlive lib/cli.js or the CI job that checks it", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const security = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
    if (!readme.includes(CLAIM) && !security.includes(CLAIM)) {
      // Nothing to hold honest: neither document makes the claim any more.
      return;
    }
    expect(existsSync(path.join(repoRoot, "lib/cli.js")), "lib/cli.js does not exist").toBe(true);
    const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci, "ci.yml has no job asserting lib/ matches a fresh build").toContain(
      "Assert lib/ matches a fresh build of src/",
    );
  });

  /**
   * The drift check has to run before anything in the same job rebuilds
   * lib/: `npm test`'s `pretest` and the explicit Build step both overwrite
   * it from src/, and once that happens `npm run check:lib` compares a
   * fresh build to another fresh build of the same source, which always
   * matches regardless of whether the *committed* lib/ was ever right. That
   * defect shipped once (this is the fix for it), so the ordering that
   * fixes it is pinned here rather than left to a comment nobody re-reads
   * before "tidying" the step order back.
   */
  it("runs the lib/ drift check before anything in the job can rebuild lib/", () => {
    const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const driftCheck = ci.indexOf("name: Assert lib/ matches a fresh build of src/");
    const typecheck = ci.indexOf("name: Typecheck");
    const test = ci.indexOf("name: Test");
    const build = ci.indexOf("name: Build");
    for (const [label, index] of [["Typecheck", typecheck], ["Test", test], ["Build", build]] as const) {
      expect(driftCheck, "the drift-check step is missing").toBeGreaterThan(-1);
      expect(index, `the ${label} step is missing`).toBeGreaterThan(-1);
      expect(driftCheck, `the drift check must run before ${label}, which can rebuild lib/`).toBeLessThan(index);
    }
  });
});

describe("CONTRIBUTING.md's claim-to-enforcement table", () => {
  /**
   * The table maps each published privacy claim to the function that enforces
   * it. A wrong entry is worse than a missing one: it sends a contributor to
   * weaken the wrong function while believing they are looking at the right
   * one. It credited dimension-value redaction to `redactText`, which is the
   * unconditional credential stripper for errors and logs; the function that
   * redacts dimension values is `redactValue`.
   *
   * So every identifier named in the "Where it is enforced" column has to
   * appear in one of the files that row names.
   */
  it("names an enforcement point that exists in one of the files the row cites", () => {
    const contributing = readFileSync(path.join(repoRoot, "CONTRIBUTING.md"), "utf8");
    const offenders: string[] = [];
    let rowsChecked = 0;

    for (const line of contributing.split("\n")) {
      if (!line.startsWith("| ") || line.startsWith("| ---")) continue;
      const cells = line.split("|").map((cell) => cell.trim());
      const [, , enforced, asserted] = cells;
      if (enforced === undefined || asserted === undefined) continue;

      const files = [...`${enforced} ${asserted}`.matchAll(/`((?:src|lib|scripts)\/[\w./-]+\.(?:ts|js|mjs))`/g)]
        .map((match) => match[1]!)
        .filter((file) => existsSync(path.join(repoRoot, file)));
      const identifiers = [...enforced.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((match) => match[1]!);
      if (identifiers.length === 0) continue;

      rowsChecked += 1;
      const sources = files.map((file) => readFileSync(path.join(repoRoot, file), "utf8")).join("\n");
      for (const identifier of identifiers) {
        if (!sources.includes(identifier)) {
          offenders.push(`${identifier} is not in ${files.join(", ") || "any file this row names"}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // A parser that silently matched nothing would pass this test forever.
    expect(rowsChecked, "no claim rows with an enforcement identifier were found").toBeGreaterThan(2);
  });
});

describe("the documented Node version floor", () => {
  it("matches package.json's engines.node wherever a document states one", () => {
    // CONTRIBUTING.md said "Node 22 or newer" while package.json required
    // 22.22.3: close enough to look right and wrong enough to send somebody to
    // a version that does not run this.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const floor = /(\d+\.\d+\.\d+)/.exec(pkg.engines.node)?.[1];
    expect(floor, "package.json's engines.node has no x.y.z floor").toBeDefined();

    const stated: string[] = [];
    for (const { file, text } of readShippedDocs()) {
      for (const match of text.matchAll(/\bNode (\d+(?:\.\d+\.\d+)?)/g)) {
        stated.push(`${file}: Node ${match[1]}`);
        expect(match[1], `${file} states a Node version that is not the floor`).toBe(floor);
      }
    }
    expect(stated.length, "no document states the Node version at all").toBeGreaterThan(0);
  });
});

describe(".github/CODEOWNERS", () => {
  /**
   * CODEOWNERS is a list of paths, and a path that no longer exists protects
   * nothing while looking exactly like protection. Line 84 guarded
   * `/openclaw.plugin.json` for a whole project after the plugin manifest was
   * deleted, under a comment describing what that manifest did.
   *
   * Only anchored, non-wildcard patterns are checked: `*` matches everything
   * by design, and a pattern without a leading `/` is a name-anywhere rule
   * rather than a claim that a particular file exists.
   */
  const CODEOWNERS = readFileSync(path.join(repoRoot, ".github/CODEOWNERS"), "utf8");

  function ownedPaths(): string[] {
    const paths: string[] = [];
    for (const line of CODEOWNERS.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const pattern = trimmed.split(/\s+/)[0]!;
      if (pattern.startsWith("/") && !pattern.includes("*")) {
        paths.push(pattern);
      }
    }
    return paths;
  }

  it("protects only paths that exist", () => {
    const missing = ownedPaths().filter((pattern) => !existsSync(path.join(repoRoot, pattern)));
    expect(missing).toEqual([]);
  });

  it("names something, so the check above cannot pass vacuously", () => {
    expect(ownedPaths().length).toBeGreaterThan(5);
  });

  it("does not still name the repository this project was renamed from", () => {
    // The shipped documentation is swept for this already; CODEOWNERS was
    // outside that sweep and kept the old name in its first line.
    expect(CODEOWNERS).not.toContain("openclaw-plugin-ga4");
  });

  it("owns the tests that hold the published claims up", () => {
    for (const file of [
      "/src/privacy/surface.test.ts",
      "/src/docs.test.ts",
      "/src/docs/skill.test.ts",
    ]) {
      expect(ownedPaths(), `${file} should have a CODEOWNERS entry`).toContain(file);
    }
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
