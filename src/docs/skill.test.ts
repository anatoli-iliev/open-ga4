import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, KNOWN_FLAGS, parseArgs } from "../cli/args.js";
import { EXIT } from "../cli/exit.js";
import { parseDateRange } from "../ga4/dates.js";
import { BLOCKED_ON_VALUES } from "../setup/state.js";
import { environmentVariablesRead, repoRoot } from "../testing/files.test-support.js";

/**
 * `SKILL.md` is the contract. Everything in it is a promise about code that
 * lives somewhere else, and documentation drifts silently: a careful reader is
 * not a control, because the reader is the person who wrote the drift.
 *
 * So these assert the promises against the code. A command that does not
 * parse, a `blocked_on` value with no section, an environment variable
 * declared and never read: each fails the build rather than reaching a user as
 * a confidently wrong instruction.
 */

const SKILL = readFileSync(path.join(repoRoot, "SKILL.md"), "utf8");
const README = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const FRONTMATTER = SKILL.slice(SKILL.indexOf("---") + 3, SKILL.indexOf("\n---", 3));

/** The section a heading introduces, up to the next heading at the same level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `${heading} was not found`).toBeGreaterThan(-1);
  const level = /^#+/.exec(heading)![0];
  const rest = text.slice(start + heading.length);
  const next = new RegExp(`^${level}(?!#)`, "m").exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

/**
 * Split a documented command the way a shell would, so a quoted argument with
 * a space in it (`--range "last month"`) stays one argument. Deliberately
 * minimal: anything needing more than double quotes does not belong in
 * documentation aimed at somebody who will not open a terminal.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/** `--help` and `--version` are argv this CLI accepts, and are not commands. */
const GLOBAL_OPTIONS = new Set(["--help", "-h", "--version", "-V"]);

/**
 * Every command line a document tells someone to run.
 *
 * Three shapes are documented and all three are collected: the fully qualified
 * `node <skill-dir>/lib/cli.js report overview`, an inline `report overview`
 * in a table cell or a sentence, and a line inside a fenced block. A candidate
 * counts as a command when its first token is a real command name or a global
 * option; anything else in backticks is a field name, a flag on its own, or
 * ordinary prose.
 */
function documentedCommands(text: string): string[] {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    candidates.add(match[1]!.trim());
  }
  for (const block of text.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.split("\n")) {
      if (line.trim()) {
        candidates.add(line.trim());
      }
    }
  }

  const commands: string[] = [];
  for (const candidate of candidates) {
    let tokens = tokenize(candidate);
    if (tokens[0] === "node") {
      // Only the documented invocation, never any other node command line.
      if (tokens[1] !== "<skill-dir>/lib/cli.js") {
        continue;
      }
      tokens = tokens.slice(2);
    }
    const head = tokens[0];
    if (head === undefined) {
      continue;
    }
    if ((COMMANDS as readonly string[]).includes(head) || GLOBAL_OPTIONS.has(head)) {
      commands.push(candidate);
    }
  }
  return commands;
}

function argvOf(command: string): string[] {
  const tokens = tokenize(command);
  return tokens[0] === "node" ? tokens.slice(2) : tokens;
}

describe("SKILL.md frontmatter", () => {
  it("keeps the description short enough to render in one table cell", () => {
    const match = /description: >-\n((?:\s{2}.*\n)+)/.exec(FRONTMATTER);
    expect(match, "the frontmatter has no folded description block").not.toBeNull();
    const description = match![1]!.replace(/\s+/g, " ").trim();
    expect(description.length).toBeLessThan(300);
  });

  it("declares name, slug and repository as the same string", () => {
    expect(FRONTMATTER).toContain("name: open-ga4");
    expect(FRONTMATTER).toContain("anatoli-iliev/open-ga4");
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe("open-ga4");
    expect(FRONTMATTER).toContain(`version: ${pkg.version}`);
  });

  it("requires node and nothing else", () => {
    expect(FRONTMATTER).toMatch(/requires:\s*\n\s+bins:\s*\[node\]/);
  });

  /**
   * `requires.env` is the unconditional gate, and a skill that fails it is
   * invisible to the model. Credentials resolve four ways (GA4_CREDENTIALS as
   * contents, GA4_CREDENTIALS as a path, GOOGLE_APPLICATION_CREDENTIALS,
   * gcloud application-default), so naming any one of them here would report
   * "needs setup" forever for users of the other three.
   */
  it("requires nothing in requires.env", () => {
    expect(FRONTMATTER).not.toMatch(/requires:[\s\S]*?\n\s+env:/);
  });
});

describe("SKILL.md commands", () => {
  it("routes every command from the decision table, and invents none", () => {
    const table = section(SKILL, "## What to run");
    const routed = new Set<string>();
    for (const match of table.matchAll(/\|\s*`([^`]+)`\s*\|/g)) {
      const head = tokenize(match[1]!)[0]!;
      expect(COMMANDS, `the decision table routes to "${head}", which is not a command`)
        .toContain(head);
      routed.add(head);
    }
    expect(routed).toEqual(new Set(COMMANDS));
  });

  it("quotes only commands that parse, in SKILL.md and README.md", () => {
    const failures: string[] = [];
    for (const [file, text] of [
      ["SKILL.md", SKILL],
      ["README.md", README],
    ] as const) {
      for (const command of documentedCommands(text)) {
        try {
          parseArgs(argvOf(command));
        } catch (error) {
          failures.push(`${file}: ${command} (${error instanceof Error ? error.message : error})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("quotes at least one command in each document, so the check cannot pass vacuously", () => {
    expect(documentedCommands(SKILL).length).toBeGreaterThan(COMMANDS.length);
    expect(documentedCommands(README).length).toBeGreaterThan(0);
  });

  /**
   * The decision table is not the only place a command name is written down.
   * The Reference section lists all seven again with a description, and an
   * invented name there would have reached a reader exactly as easily.
   */
  it("lists every command in the reference table, and invents none", () => {
    const reference = section(SKILL, "### Commands");
    const listed = new Set<string>();
    for (const match of reference.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) {
      const head = tokenize(match[1]!)[0]!;
      expect(COMMANDS, `the reference table lists "${head}", which is not a command`)
        .toContain(head);
      listed.add(head);
    }
    expect(listed).toEqual(new Set(COMMANDS));
  });

  /**
   * The flag table against `KNOWN_FLAGS`, in both directions: a flag
   * documented on a command that does not accept it sends an agent to an
   * "unknown option" error, and a flag a command accepts but nobody wrote down
   * is a capability the agent will never use.
   *
   * `--help` is the one documented flag with no `KNOWN_FLAGS` entry, because
   * `parseArgs` handles it before it validates flags at all. It is excluded by
   * name rather than by a loose rule.
   */
  it("documents exactly the flags each command accepts", () => {
    const documented = new Map<string, Set<string>>(
      COMMANDS.map((command) => [command, new Set<string>()]),
    );
    for (const line of section(SKILL, "### Flags").split("\n")) {
      if (!line.startsWith("| `--")) {
        continue;
      }
      const cells = line.split("|").map((cell) => cell.trim());
      const flags = [...cells[1]!.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]!);
      const targets = /\ball\b/.test(cells[2]!)
        ? [...COMMANDS]
        : cells[2]!.split(",").map((name) => name.trim());
      for (const target of targets) {
        expect(COMMANDS, `the flag table names "${target}", which is not a command`)
          .toContain(target);
        for (const flag of flags) {
          if (flag !== "help") {
            documented.get(target)!.add(flag);
          }
        }
      }
    }

    for (const command of COMMANDS) {
      expect(documented.get(command), `flags documented for ${command}`)
        .toEqual(new Set(KNOWN_FLAGS[command]));
    }
  });

  it("writes the full invocation as node <skill-dir>/lib/cli.js, never a hardcoded path", () => {
    // A launcher script would arrive without its executable bit through
    // ClawHub's installer, and a hardcoded path is wrong for a --global
    // install, so the documented form is the interpreter plus a relative path.
    for (const [file, text] of [
      ["SKILL.md", SKILL],
      ["README.md", README],
    ] as const) {
      expect(text, `${file} should document the interpreter invocation`)
        .toContain("node <skill-dir>/lib/cli.js");
      expect(text, `${file} hardcodes an install path`).not.toMatch(
        /~\/\.openclaw\/workspace\/skills\/open-ga4\/lib/,
      );
    }
  });
});

describe("SKILL.md setup tree", () => {
  const headings = [...SKILL.matchAll(/^### blocked_on: `([a-z_]+)`$/gm)].map((match) => match[1]!);

  it("has one section per blocked_on value the code can emit", () => {
    expect(new Set(headings)).toEqual(new Set(BLOCKED_ON_VALUES));
  });

  it("has no section for a value the code cannot emit", () => {
    for (const heading of headings) {
      expect(BLOCKED_ON_VALUES, `no code path emits blocked_on "${heading}"`).toContain(heading);
    }
  });

  it("sends the missing grant to Google Analytics rather than to Cloud IAM", () => {
    // The one step everybody gets wrong. A section that sends someone to
    // Google Cloud IAM here would be confidently, expensively wrong: an IAM
    // role grants no analytics access at all.
    const grant = section(SKILL, "### blocked_on: `no_property_grant`");
    expect(grant).toContain("Property access management");
    expect(grant).toContain("Viewer");
    expect(grant).toContain("https://analytics.google.com/analytics/web/");
    expect(grant).toMatch(/not in Google Cloud|Cloud IAM|a Cloud IAM role does absolutely\s+nothing/);
  });
});

describe("SKILL.md environment variables", () => {
  const declared = new Set(
    [...FRONTMATTER.matchAll(/- name: ([A-Z0-9_]+)/g)].map((match) => match[1]!),
  );

  /**
   * Not documentation hygiene. ClawHub's security review compares declared
   * metadata against actual behaviour, so a variable the code reads and does
   * not declare is a publishing problem: the skill does something its manifest
   * does not admit to.
   */
  it("declares every variable the code reads, and reads every one it declares", () => {
    expect(declared).toEqual(environmentVariablesRead());
  });

  it("declares the same set the design spec settled on", () => {
    const spec = readFileSync(
      path.join(repoRoot, "docs/superpowers/specs/2026-08-16-open-ga4-design.md"),
      "utf8",
    );
    const frontmatterBlock = section(spec, "### D6. The frontmatter contract");
    const inSpec = new Set(
      [...frontmatterBlock.matchAll(/- name: ([A-Z0-9_]+)/g)].map((match) => match[1]!),
    );
    // The count is asserted from the spec rather than written here, so a
    // variable added or removed has one place to change, not two. NO_COLOR was
    // the eighth until the final review: nothing shipped emits an escape
    // sequence, and the one function that read it had no caller, so it was a
    // setting the manifest invited a user to set that could not do anything.
    expect(inSpec.size).toBeGreaterThan(0);
    expect(declared).toEqual(inSpec);

    // The rest of the spec's frontmatter block is a worked example of the file
    // this test is checking, so it goes stale in exactly the same way. Its
    // version outlived package.json's once already.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(frontmatterBlock).toContain(`version: ${pkg.version}`);
    expect(frontmatterBlock).toContain(`name: ${pkg.name}`);
  });

  it("gives the four privacy settings no command-line flag", () => {
    // These weaken a default, and a flag can be set by the model while an
    // environment variable is set by a person. src/cli/args.ts rejects them;
    // SKILL.md has to say so, or the model will try.
    const privacy = section(SKILL, "### Privacy");
    for (const name of [
      "GA4_REDACT",
      "GA4_ALLOW_USER_DIMENSIONS",
      "GA4_PROPERTY_ALLOWLIST",
      "GA4_AUDIT_LOG",
    ]) {
      expect(privacy, `the Privacy section should name ${name}`).toContain(name);
      expect(declared, `${name} should be declared in the frontmatter`).toContain(name);
    }
    expect(privacy).toMatch(/no command-line flag/i);
  });
});

describe("SKILL.md date ranges", () => {
  /**
   * Which ranges run up to today is a fact both SKILL.md and README.md have
   * described, and README.md got it wrong: it called `live` "the only command
   * that sees today" while four ranges end on today and any command taking
   * `--range` can use them. Pinned against the parser rather than re-read by a
   * human, so the sentence cannot outlive the behaviour.
   */
  const RANGES = [
    "today",
    "yesterday",
    "last 7 days",
    "last 28 days",
    "last 30 days",
    "last 90 days",
    "this week",
    "last week",
    "this month",
    "last month",
    "this year",
    "last year",
  ];

  it("documents every range the parser accepts", () => {
    const section_ = section(SKILL, "### Date ranges");
    for (const range of RANGES) {
      expect(section_, `the date-range section should name ${range}`).toContain(`\`${range}\``);
    }
  });

  it("names the ranges that run up to today, and only those", () => {
    const today = new Date("2026-08-12T09:30:00Z");
    const endingToday = RANGES.filter((range) => parseDateRange(range, today).endDate === "today");
    expect(endingToday).toEqual(["today", "this week", "this month", "this year"]);

    const section_ = section(SKILL, "### Date ranges");
    for (const range of endingToday) {
      expect(section_, `${range} runs up to today and the section should say so`)
        .toMatch(new RegExp(`\`${range}\``));
    }
    expect(section_).toMatch(/run up to today|so far/);
  });
});

describe("SKILL.md guidance", () => {
  it("documents exactly the exit codes the CLI can return", () => {
    // Both directions. A code in the table that the CLI cannot return is a
    // promise about behaviour that does not exist (exit 1 was exactly that
    // until UNEXPECTED stopped being folded into "Google refused"), and a code
    // the CLI can return with no row here leaves the agent guessing at the
    // moment it most needs an instruction. src/cli/exit.test.ts asserts the
    // other half: that exitCodeFor can actually produce each of these.
    const table = section(SKILL, "## Exit codes");
    const documented = new Set([...table.matchAll(/^\| (\d+) \|/gm)].map((match) => Number(match[1])));
    expect(documented).toEqual(new Set(Object.values(EXIT)));
  });

  it("tells the agent that zero rows is exit 0 and not a failure", () => {
    const exitCodes = section(SKILL, "## Exit codes");
    expect(exitCodes).toMatch(/zero rows/i);
    expect(exitCodes).toMatch(/no data for that period|successful measurement of nothing/i);
  });

  it("tells the agent never to state a number that was not measured", () => {
    expect(SKILL).toContain("Never state a number that was not measured");
  });

  it("tells the agent that dimension values are written by site visitors", () => {
    const untrusted = section(SKILL, "## Analytics values are untrusted input");
    expect(untrusted).toMatch(/whoever\s+visited\s+the\s+site|written\s+by\s+site\s+visitors/i);
  });

  it("tells the agent to list and ask rather than guess a property", () => {
    const vague = section(SKILL, "## When the question is vague");
    expect(vague).toMatch(/ask which one|list them and ask/i);
  });

  it("reserves --json for figures that must be computed", () => {
    const json = section(SKILL, "## When to use `--json`");
    expect(json).toMatch(/computed/i);
    expect(json).toMatch(/quote/i);
  });

  it("distinguishes report's substring --filter from query's condition", () => {
    // The two spellings are not interchangeable and one of them fails
    // silently: `report --filter country:exact:US` substring-matches that
    // literal text and returns nothing. Both forms are spelled out so an agent
    // cannot infer the wrong one from the other.
    const filters = section(SKILL, "### `--filter` means two different things");
    expect(filters).toContain("field:operator:value");
    expect(filters).toMatch(/substring/i);
    // compare parses no --filter at all, so documenting one would be inventing it.
    expect(() => parseArgs(["compare", "overview", "--filter", "x"])).toThrow();
    expect(() => parseArgs(["report", "top_pages", "--filter", "/blog"])).not.toThrow();
    expect(() => parseArgs(["query", "--metrics", "activeUsers", "--filter", "country:exact:US"]))
      .not.toThrow();
  });

  /**
   * The grammar is found by locating the operator, not by counting colons,
   * which is why both a filter's value (a URL) and its field (a custom
   * dimension) may contain a colon of their own. An earlier version of this
   * section (and of the parser) assumed only the value could: it described
   * splitting "on the first two colons only", which made every GA4 custom
   * dimension (`customUser:<name>`, `customEvent:<name>`, `customItem:<name>`)
   * unfilterable, because `customEvent:plan_tier:exact:pro` split into field
   * `customEvent`, operator `plan_tier`, an unknown operator. This pins the
   * corrected description against regressing to that phrasing, and against
   * the worked example silently going stale.
   */
  it("documents that a filter field, not only its value, may itself contain a colon", () => {
    const filters = section(SKILL, "### `--filter` means two different things");
    expect(filters).not.toMatch(/first two colons/i);
    expect(filters).toContain("customEvent:plan_tier:exact:pro");
    expect(filters).toContain("customEvent:plan_tier");
    expect(filters).toMatch(/colon in its name/i);
    expect(() =>
      parseArgs([
        "query",
        "--metrics",
        "activeUsers",
        "--dimensions",
        "eventName",
        "--filter",
        "customEvent:plan_tier:exact:pro",
      ]),
    ).not.toThrow();
  });
});
