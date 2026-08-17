import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./testing/files.test-support.js";

/**
 * `.github/workflows/release.yml` is the only place in this repository that
 * can put a listing on ClawHub. Several properties of it would fail silently
 * and expensively if a future edit undid them, and none would be caught by
 * anything else in the suite (nothing here runs the workflow itself; GitHub
 * Actions is not something `npm test` can execute), so they are pinned as
 * assertions against the committed YAML: most as text matches, the same
 * technique `src/docs.test.ts` already uses on `ci.yml`, and the version
 * guard by actually running the shell script the workflow would run, since a
 * regex embedded in someone else's `run:` block deserves the same scrutiny as
 * one written directly in a test.
 *
 * Not pinned here, considered and rejected: that the action SHAs match
 * `ci.yml`'s (a drift there is a maintenance nuisance, not a silent one:
 * Dependabot's weekly PR would still show a divergent pin, and a security
 * scan would still catch an unpinned or stale action; it does not put a
 * wrong bundle on the registry the way the properties below do).
 */

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

/**
 * The publisher's pinned install: a manifest and a lockfile that exist only so
 * the step holding `CLAWHUB_TOKEN` runs a tree this repository has recorded,
 * and the binary that install produces.
 */
const PUBLISH_DIR = ".github/publish";
const PUBLISHER_BIN = `${PUBLISH_DIR}/node_modules/.bin/clawhub`;
const INSTALL_STEP = "Install the pinned ClawHub publisher";
const PUBLISH_STEP = "Publish to ClawHub";
/** The step that installs the project's own devDependencies, not the publisher. */
const PROJECT_INSTALL_STEP = "Install dependencies";

/**
 * A top-level block scalar key (`on:`, `permissions:`), isolated from
 * whatever follows it at the same or a shallower indentation. Scanning the
 * whole file for, say, `push:` would also match nothing today, which is
 * exactly why isolating the block matters: a future step that legitimately
 * needed to `git push` or reference a `push` variable should not make a test
 * about the trigger start failing for an unrelated reason.
 */
function topLevelBlock(yaml: string, key: string): string {
  const match = new RegExp(`^${key}:\\n([\\s\\S]*?)(?=\\n\\S)`, "m").exec(yaml);
  if (!match) {
    throw new Error(`no top-level ${key}: block found`);
  }
  return match[1]!;
}

describe("the release workflow's trigger", () => {
  it("fires on a published release and nothing else", () => {
    const on = topLevelBlock(workflow, "on");
    expect(on).toMatch(/^\s*release:\s*\n\s*types:\s*\[published\]\s*$/m);
  });

  /**
   * A publish workflow that can fire on a push is a foot-gun: one bad merge
   * and a broken build is on the registry forever. `ci.yml` carries a
   * comment saying exactly that; this is the same claim, checked as an
   * absence rather than trusted as a comment nobody re-reads before adding a
   * second trigger next to the first.
   */
  it("never fires on a push, a pull request, or a manual dispatch", () => {
    const on = topLevelBlock(workflow, "on");
    for (const trigger of ["push", "pull_request", "workflow_dispatch", "schedule"]) {
      expect(on, `release.yml's on: block should not mention ${trigger}`).not.toMatch(
        new RegExp(`^\\s*${trigger}\\s*:`, "m"),
      );
    }
  });
});

describe("the ClawHub publish step", () => {
  /**
   * `clawhub` resolves a relative folder argument against its own working
   * directory, which silently falls back to the OpenClaw workspace directory
   * when the current directory has no `.clawhub/` marker: `publish .` would
   * upload the wrong directory and then report `SKILL.md required` about a
   * directory nobody named. `GITHUB_WORKSPACE` is the absolute path GitHub
   * Actions guarantees for the checkout, so it is the one argument this
   * cannot happen to.
   */
  it("publishes GITHUB_WORKSPACE as an absolute path", () => {
    expect(workflow).toContain('skill publish "$GITHUB_WORKSPACE"');
  });

  it("never publishes a bare relative path", () => {
    // Read out of the step's own `run:` block rather than found by scanning
    // the whole file. The comments around this step name the subcommand too
    // (explaining the trap this test guards against), and an earlier version
    // of this test matched one of those comments instead of the invocation,
    // passing regardless of what the invocation actually said. The script is
    // the only text here that a shell will ever execute.
    const publishLine = stepRunScript(workflow, PUBLISH_STEP)
      .split("\n")
      .find((line) => line.includes("skill publish"));
    expect(publishLine, `no \`skill publish\` invocation in the ${PUBLISH_STEP} step`).toBeDefined();
    // Catches both `publish .` and `publish "."`: a bare dot, quoted or not,
    // immediately after the subcommand, with nothing before it that would
    // make it absolute.
    expect(publishLine).not.toMatch(/skill publish\s+"?\."?(?:\s|$)/);
  });
});

describe("the ClawHub tag for a prerelease", () => {
  /**
   * GitHub fires `release: published` for prereleases too: `prereleased` is
   * a separate event type that exists alongside `published`, not instead of
   * it, so checking "this is a pre-release" in the GitHub UI does not stop
   * this workflow from running. The publish step used to hardcode
   * `--tags latest`, which would have aliased a beta as the default
   * `openclaw skills install @anatoli-iliev/open-ga4` gets.
   *
   * Pinned as the exact expected expression text, not a regex that only
   * captures the two string literals either side of `&&`/`||`: a looser
   * match here has a real, worse-than-the-original-bug failure mode. A GitHub
   * Actions `${{ ... }}` expression is not something this suite can evaluate
   * (there is no interpreter for it available here), so a mutation like
   * `!github.event.release.prerelease && 'prerelease' || 'latest'` inverts
   * the behaviour (every real release tagged `prerelease`, every beta tagged
   * `latest`) while keeping both literals and their order exactly as before,
   * and a regex anchored only on the literals cannot see the inserted `!`.
   * Matching the whole line is acceptable here because it is short and
   * changes rarely, and a test that fails whenever this exact condition is
   * touched is doing its job on a path where a silent regression reaches a
   * public registry.
   */
  const EXPECTED_TAG_LINE = "CLAWHUB_TAGS: ${{ github.event.release.prerelease && 'prerelease' || 'latest' }}";

  it("computes the tag from an unnegated github.event.release.prerelease, with the non-prerelease branch pinned to latest", () => {
    const tagLine = workflow.split("\n").find((line) => line.includes("CLAWHUB_TAGS:"));
    expect(tagLine, "no CLAWHUB_TAGS assignment found in release.yml").toBeDefined();
    expect(tagLine!.trim(), "CLAWHUB_TAGS is not computed by the exact expected expression").toBe(
      EXPECTED_TAG_LINE,
    );
  });

  /**
   * Computing the right value is only half the fix: nothing above ties
   * `CLAWHUB_TAGS` to the invocation that is supposed to consume it.
   * Reverting only `--tags "$CLAWHUB_TAGS"` back to `--tags latest`, while
   * leaving the now-unused `CLAWHUB_TAGS:` env line sitting above it, is a
   * plausible "simplification" edit that the previous test alone would not
   * catch, since it only ever reads the env line, never the invocation.
   */
  it("passes the computed tag to skill publish", () => {
    // The invocation spans several lines, each ending in a shell line
    // continuation (`\`), so `--tags` lands on a different source line than
    // `npx clawhub`; the whole step's script is checked as one string rather
    // than one split line, the same reason `stepRunScript` exists below.
    const script = stepRunScript(workflow, PUBLISH_STEP);
    expect(script).toContain("skill publish");
    expect(script).toContain('--tags "$CLAWHUB_TAGS"');
  });
});

/**
 * The exact shell script inside a named step's `run: |` block, dedented back
 * to what a shell would see. This is the mechanism that lets the version
 * guard below actually execute what the workflow would execute, rather than
 * asserting that some text resembling a semver check is present somewhere in
 * the file: a regex written once here and a second, possibly-drifted one
 * embedded in the YAML would both pass a text-matching test while agreeing
 * with each other and disagreeing with reality.
 */
function stepRunScript(yaml: string, stepName: string): string {
  const lines = yaml.split("\n");
  const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (nameIndex === -1) {
    throw new Error(`no step named "${stepName}" found in release.yml`);
  }
  const runIndex = lines.findIndex((line, i) => i > nameIndex && line.trim() === "run: |");
  if (runIndex === -1) {
    throw new Error(`step "${stepName}" has no "run: |" block`);
  }
  const baseIndent = /^(\s*)/.exec(lines[runIndex]!)![1]!.length;
  const contentIndent = baseIndent + 2;
  const scriptLines: string[] = [];
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      scriptLines.push("");
      continue;
    }
    const indent = /^(\s*)/.exec(line)![1]!.length;
    if (indent < contentIndent) {
      break;
    }
    scriptLines.push(line.slice(contentIndent));
  }
  return scriptLines.join("\n");
}

/** Runs `script` in bash with GITHUB_REF_NAME set, the way the step would see it. */
function runVersionGuard(refName: string): { status: number; output: string } {
  const script = stepRunScript(workflow, "Validate the release version");
  try {
    const stdout = execFileSync("bash", ["-c", script], {
      env: { ...process.env, GITHUB_REF_NAME: refName },
      encoding: "utf8",
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("the release version guard", () => {
  /**
   * `--version "${GITHUB_REF_NAME#v}"` only strips a leading `v`; whatever is
   * left reaches `clawhub skill publish` unvalidated. Whether ClawHub itself
   * rejects a malformed version is server-side and not something this
   * repository can test or assume, so this step exists to fail first,
   * naming the exact bad tag, before anything reaches the registry to find
   * out. Prerelease and build-metadata suffixes are both accepted, because a
   * real prerelease version string (`1.2.3-beta.1`) is a different thing
   * from the `prerelease` checkbox tested above: a tag can be plain `v1.2.3`
   * and still be flagged as a pre-release in the GitHub UI.
   *
   * Executes the actual script from `release.yml`, not a copy of it: see
   * `stepRunScript` above for why a second regex written here would not have
   * caught the two disagreeing.
   */
  it("accepts a plain release version", () => {
    const result = runVersionGuard("v1.2.3");
    expect(result.status, result.output).toBe(0);
  });

  it("accepts a version with a prerelease and build suffix", () => {
    const result = runVersionGuard("v1.2.3-beta.1+build.5");
    expect(result.status, result.output).toBe(0);
  });

  it("rejects a two-segment tag, naming it", () => {
    const result = runVersionGuard("v1.0");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("v1.0");
  });

  it("rejects a non-numeric tag, naming it", () => {
    const result = runVersionGuard("release-aug");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("release-aug");
  });

  it("rejects a version with a leading zero", () => {
    const result = runVersionGuard("v01.2.3");
    expect(result.status).not.toBe(0);
  });
});

describe("the drift check's position in the release job", () => {
  /**
   * Same defect class as the one `src/docs.test.ts` already pins for
   * `ci.yml`: `npm test`'s `pretest` script runs `npm run build`, which
   * overwrites `lib/` from `src/`. If the drift check ran after Typecheck or
   * Test, it would compare a fresh build in a temporary directory to a fresh
   * build already sitting in the working tree, from the same source, which
   * always matches regardless of whether the *committed* `lib/`, the
   * directory this job is about to publish, ever agreed with `src/` at all.
   * That would make the release workflow publish a bundle whose committed
   * output does not match its source without ever failing on it, which is
   * the exact lie the drift check exists to catch.
   */
  it("runs before Typecheck or Test can rebuild lib/", () => {
    const driftCheck = workflow.indexOf("name: Assert lib/ matches a fresh build of src/");
    const typecheck = workflow.indexOf("name: Typecheck");
    const test = workflow.indexOf("name: Test");
    expect(driftCheck, "the drift-check step is missing").toBeGreaterThan(-1);
    for (const [label, index] of [["Typecheck", typecheck], ["Test", test]] as const) {
      expect(index, `the ${label} step is missing`).toBeGreaterThan(-1);
      expect(driftCheck, `the drift check must run before ${label}, which can rebuild lib/`).toBeLessThan(index);
    }
  });
});

describe("workflow permissions stay minimal", () => {
  /**
   * Disclosed as a gap in this workflow's own first review: nothing pinned
   * that `permissions: contents: read` stays the only permission granted. A
   * future change adding, say, `contents: write` for a step that does not
   * need it would have passed every other test in this suite. `ci.yml`
   * carries the identical unpinned risk, so both files are checked here
   * rather than only the one this task added, so the two cannot drift apart
   * on this.
   */
  for (const file of [".github/workflows/release.yml", ".github/workflows/ci.yml"]) {
    it(`${file} grants only contents: read`, () => {
      const yaml = readFileSync(path.join(repoRoot, file), "utf8");
      const block = topLevelBlock(yaml, "permissions");
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines).toEqual(["contents: read"]);
    });
  }
});

/**
 * Every step of the one job in this workflow, in file order, each with the
 * lines that belong to it.
 *
 * **Full-line comments are stripped before the split.** That is what makes the
 * step boundaries reliable: a comment block sits at the same indentation as
 * the `- name:` below it and explains the step it precedes, so attributing
 * those lines by indentation alone would file the next step's prose under the
 * previous step. Once comments are gone, everything between two `- name:`
 * lines is the first step's body and nothing else. It also means these tests
 * assert on what the runner would execute rather than on what a comment claims,
 * which is the whole point of testing a workflow file. Trailing comments (the
 * ` # v7.0.1` after an action SHA) survive and are harmless.
 *
 * Anything before the first step (the trigger, the permissions block, a
 * job-level `env:`) is collected under `JOB_LEVEL`, so a secret introduced
 * there rather than on a step is visible to the checks below instead of
 * silently belonging to nobody.
 */
const JOB_LEVEL = "the workflow or job itself, outside any step";

function workflowSteps(yaml: string): Array<{ name: string; body: string }> {
  const collected: Array<{ name: string; body: string }> = [{ name: JOB_LEVEL, body: "" }];
  for (const line of yaml.split("\n")) {
    if (line.trim().startsWith("#")) {
      continue;
    }
    const named = /^\s*- name:\s*(.+?)\s*$/.exec(line);
    if (named) {
      collected.push({ name: named[1]!, body: "" });
      continue;
    }
    collected[collected.length - 1]!.body += `${line}\n`;
  }
  return collected;
}

function stepBody(yaml: string, stepName: string): string {
  const step = workflowSteps(yaml).find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`no step named "${stepName}" found in release.yml`);
  }
  return step.body;
}

/** Every npm install invocation in the workflow, with the step it runs in. */
function npmInstallLines(yaml: string): Array<{ step: string; line: string }> {
  const found: Array<{ step: string; line: string }> = [];
  for (const step of workflowSteps(yaml)) {
    for (const line of step.body.split("\n")) {
      if (/\bnpm\s+(?:ci|install|i)\b/.test(line)) {
        found.push({ step: step.name, line: line.trim() });
      }
    }
  }
  return found;
}

/** Every step whose lines reference a repository secret. */
function stepsReadingASecret(yaml: string): string[] {
  return workflowSteps(yaml)
    .filter((step) => /\$\{\{\s*secrets\./.test(step.body))
    .map((step) => step.name);
}

/**
 * The publisher's pinned install, read from the two committed files rather
 * than from a version written down here.
 */
function publisherManifest(): {
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(repoRoot, PUBLISH_DIR, "package.json"), "utf8"));
}

function publisherLockfile(): {
  lockfileVersion: number;
  packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
} {
  return JSON.parse(readFileSync(path.join(repoRoot, PUBLISH_DIR, "package-lock.json"), "utf8"));
}

/**
 * The publish step is the only place in this repository that runs code it did
 * not write while holding a credential that can put a listing on ClawHub, and
 * whoever holds that credential can ship arbitrary JavaScript to every machine
 * that installs this skill, which is a machine with a Google service-account
 * private key on it. That is the worst outcome reachable from this repository,
 * so the two properties that stand between the two are pinned here.
 *
 * The defect these replace: the step ran `npx clawhub@<version> skill publish`,
 * which pins the top-level package and nothing beneath it. Every transitive
 * dependency was resolved by semver range at the moment the release ran and
 * unpacked with npm lifecycle scripts enabled, in a step whose environment held
 * `CLAWHUB_TOKEN` and `GH_TOKEN`. A hijacked patch version anywhere in that
 * tree could read the token from `process.env` during install. The project's
 * own devDependencies never had that exposure: they come from a committed
 * `package-lock.json` with an integrity hash per package.
 *
 * Neither half is observable from anything else in the suite. `npm test` cannot
 * run GitHub Actions, and a release runs once, unattended, with a real token,
 * which is the worst possible place to discover that a "simplification" back to
 * one `npx` line undid this.
 */
describe("the pinned ClawHub publisher", () => {
  it("is installed from a manifest and a lockfile committed to this repository", () => {
    for (const file of [`${PUBLISH_DIR}/package.json`, `${PUBLISH_DIR}/package-lock.json`]) {
      expect(existsSync(path.join(repoRoot, file)), `${file} is missing`).toBe(true);
    }
  });

  /**
   * The one requirement that makes the lockfile mean anything: a range in the
   * manifest with a lockfile beside it is still deterministic until somebody
   * runs `npm install`, at which point the range silently picks up whatever is
   * newest. An exact version says the pin is deliberate.
   */
  it("names the publisher at an exact version, never a range or a dist-tag", () => {
    const manifest = publisherManifest();
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(declared), "the publisher manifest should declare clawhub and nothing else")
      .toEqual(["clawhub"]);
    const spec = declared.clawhub!;
    expect(spec, `clawhub is pinned as "${spec}", which is not an exact version`)
      .toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  /**
   * This skill installs no npm package on a user's machine, and five documents
   * build an argument on that. A second `package.json` in the repository is the
   * one thing that could make that claim ambiguous, so the publisher is
   * declared where npm itself puts tooling, and the manifest is marked private
   * so it can never be published as a package in its own right.
   */
  it("is declared as tooling, so it cannot be read as something the skill installs", () => {
    const manifest = publisherManifest();
    expect(manifest.private, "the publisher manifest must be private").toBe(true);
    expect(manifest.dependencies ?? {}, "the publisher is tooling; declare it under devDependencies")
      .toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual(["clawhub"]);
  });

  /**
   * The whole point of choosing a lockfile over a bare `--ignore-scripts`
   * install: an integrity hash for every package in the tree, not just
   * determinism at the moment somebody last resolved it. Without the hashes,
   * `npm ci` would still fetch whatever the recorded URL serves today.
   */
  it("records every package in the publisher's tree, each with an integrity hash", () => {
    const lockfile = publisherLockfile();
    expect(lockfile.lockfileVersion, "lockfileVersion 2 or newer is what carries `packages`")
      .toBeGreaterThanOrEqual(2);
    const packages = Object.entries(lockfile.packages ?? {}).filter(([name]) => name !== "");
    // A lockfile holding only the root entry would pass every check below
    // while pinning nothing at all.
    expect(packages.length, "the publisher lockfile resolves no dependencies").toBeGreaterThan(1);
    const unpinned = packages
      .filter(([, entry]) => !entry.integrity || !entry.resolved)
      .map(([name]) => name);
    expect(unpinned, "every package in the publisher's tree needs an integrity hash").toEqual([]);
  });

  it("locks the same version the manifest asks for", () => {
    const manifest = publisherManifest();
    const spec = { ...manifest.dependencies, ...manifest.devDependencies }.clawhub;
    expect(publisherLockfile().packages?.["node_modules/clawhub"]?.version).toBe(spec);
  });

  /**
   * An install script is the vector that does not need the publisher itself to
   * be compromised, only something it depends on, and it runs before a single
   * line of the tool's own code does. Nothing in the tree declares one today,
   * which is exactly why the flag has to be pinned rather than trusted: a
   * hijacked patch version adding one is the attack, and it would arrive
   * between two releases with nobody looking.
   *
   * Scoped to every step except the project's own `npm ci`, so a future step
   * that installs anything else in this credential-bearing workflow has to
   * argue with this test first. The project's install is deliberately exempt:
   * `esbuild` and `fsevents` in the root lockfile both declare install scripts
   * and vitest does not work without them, and that install is integrity-hashed
   * from a committed lockfile with no secret in its environment.
   */
  it("installs the publisher with npm lifecycle scripts disabled", () => {
    const installs = npmInstallLines(workflow);
    expect(installs.length, "no npm install invocation found in release.yml").toBeGreaterThan(0);
    const publisherInstalls = installs.filter((install) => install.step !== PROJECT_INSTALL_STEP);
    expect(publisherInstalls.length, `no install step other than ${PROJECT_INSTALL_STEP}`)
      .toBeGreaterThan(0);
    for (const install of publisherInstalls) {
      expect(install.line, `${install.step} installs without --ignore-scripts`)
        .toContain("--ignore-scripts");
    }
  });

  it("installs the publisher from the pinned directory", () => {
    const script = stepRunScript(workflow, INSTALL_STEP);
    expect(script).toContain(PUBLISH_DIR);
    expect(script).toContain("npm ci");
  });

  /**
   * Splitting install from publish is the other half of the fix, and it is
   * worth nothing if the install step can still see the token: an install
   * script reads `process.env`, so a secret present in that step is a secret
   * an unvetted tarball can exfiltrate before any of this repository's own
   * code runs.
   */
  it("puts no secret in the install step's environment", () => {
    expect(stepBody(workflow, INSTALL_STEP)).not.toMatch(/\$\{\{\s*secrets\./);
    expect(stepBody(workflow, INSTALL_STEP)).not.toContain("CLAWHUB_TOKEN");
  });

  /**
   * The same claim as the test above, made as a whitelist rather than an
   * absence, so a secret added to some third step is caught as well as one
   * added to the install step. `JOB_LEVEL` covers a job-level `env:` block,
   * which would hand a secret to every step at once, install included, without
   * any step's own text mentioning it.
   */
  it("gives a secret only to the step that checks for it and the step that uses it", () => {
    expect(stepsReadingASecret(workflow)).toEqual(["Require CLAWHUB_TOKEN", PUBLISH_STEP]);
  });

  /**
   * `npx` is the shape of the original defect. `npx clawhub@0.23.3` reads as
   * pinned and is not: it resolves and installs a fresh dependency tree, in
   * this step, with the token already in scope. Checked against the workflow
   * with its comments stripped, because the comments explaining why this is
   * banned necessarily contain the word.
   */
  it("never resolves the publisher through npx", () => {
    const executable = workflowSteps(workflow)
      .map((step) => step.body)
      .join("\n");
    expect(executable, "npx resolves at release time; use the pinned install").not.toMatch(/\bnpx\b/);
  });

  it("runs the publisher binary the pinned install produced, by absolute path", () => {
    const script = stepRunScript(workflow, PUBLISH_STEP);
    expect(script).toContain(`"$GITHUB_WORKSPACE/${PUBLISHER_BIN}" skill publish`);
  });

  /**
   * Ordering: the binary has to exist before it is invoked, and the two steps
   * have to stay two steps. Merging them back into one, which is the tidy-up
   * this whole group exists to prevent, is caught by the secret checks above;
   * this catches the other direction, an install step reordered to after the
   * step that uses it.
   */
  it("installs the publisher before the step that publishes", () => {
    const names = workflowSteps(workflow).map((step) => step.name);
    expect(names).toContain(INSTALL_STEP);
    expect(names.indexOf(INSTALL_STEP)).toBeLessThan(names.indexOf(PUBLISH_STEP));
  });
});

/**
 * SECURITY.md describes the release path to somebody deciding whether to trust
 * this skill with a Google credential, and a claim there that quietly stops
 * being true is worse than no claim: a reader has no way to check it without
 * reading the workflow themselves, which is the work the document is meant to
 * save them. Same shape as the committed-build-output claim in
 * `src/docs.test.ts`: the claim is allowed to be made only while the mechanism
 * behind it is still in place, and deleting the sentence is the honest way out
 * if it ever is not.
 */
describe("SECURITY.md's claim about how the publisher is installed", () => {
  const CLAIM = "with an integrity hash for every package in its tree";
  const security = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");

  it("is made", () => {
    expect(security).toContain(CLAIM);
  });

  it("cannot outlive the pinned install it describes", () => {
    if (!security.includes(CLAIM)) {
      // Nothing to hold honest: the document no longer makes the claim.
      return;
    }
    expect(existsSync(path.join(repoRoot, PUBLISH_DIR, "package-lock.json")), "the lockfile is gone")
      .toBe(true);
    const install = stepRunScript(workflow, INSTALL_STEP);
    expect(install, "the publisher is no longer installed with npm ci").toContain("npm ci");
    expect(install, "the publisher install no longer disables lifecycle scripts")
      .toContain("--ignore-scripts");
    expect(stepBody(workflow, INSTALL_STEP), "the install step can now see a secret")
      .not.toMatch(/\$\{\{\s*secrets\./);
  });
});
