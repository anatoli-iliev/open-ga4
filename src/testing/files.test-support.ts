import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * File-walking shared by the tests that scan the repository rather than call a
 * function: the documentation tests, the skill-contract tests, and the error
 * taxonomy's "this identifier is gone everywhere" sweeps.
 *
 * There were three near-identical copies of this walk before, which is two
 * more than the number of times anybody wants to fix the same off-by-one. The
 * one rule that matters is preserved: a directory walk with `readdirSync`,
 * never `fs.globSync`.
 *
 * This file is deliberately named `.test-support.ts`, not `.test.ts`:
 * `vitest.config.ts` collects only `*.test.ts`, so it is not mistaken for a
 * suite with no tests in it, and `tsconfig.json` excludes the same suffix from
 * the build, so it never reaches `dist/`.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every file under `dir` whose name ends with `suffix`, recursed into subdirectories. */
export function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, suffix));
    } else if (entry.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Absolute paths of the TypeScript that actually ships, which is neither the
 * tests nor this file: `tsconfig.json` excludes both suffixes from the build.
 *
 * Sweeps for a retired identifier must not read test files, because a test is
 * allowed to name a retired identifier in a comment describing why it is
 * retired, and because a sweep that reads its own source trips over the string
 * literal it is searching for.
 */
export function shippedSources(): string[] {
  return listFiles(path.join(repoRoot, "src"), ".ts").filter(
    (file) => !file.endsWith(".test.ts") && !file.endsWith(".test-support.ts"),
  );
}

/**
 * The documentation a user of this skill can read, in the order somebody meets
 * it. `SKILL.md` is what the agent reads and `docs/DESIGN.md` is where the
 * reasoning lives; both are as public as the README and are held to the same
 * standard.
 *
 * Deliberately excludes `docs/superpowers/`, which holds the specs and plans
 * for the work itself. Those describe what was rejected and what changed, so
 * they name retired identifiers on purpose.
 */
export const SHIPPED_DOCS = [
  "README.md",
  "SKILL.md",
  "SETUP.md",
  "PRIVACY.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/DESIGN.md",
] as const;

export function readShippedDocs(): Array<{ file: string; text: string }> {
  return SHIPPED_DOCS.map((file) => ({
    file,
    text: readFileSync(path.join(repoRoot, file), "utf8"),
  }));
}

/**
 * Environment variables the shipped source reads, by scanning for `env.NAME`
 * and `env["NAME"]`.
 *
 * A scan rather than a list, because a list is a second place to forget. The
 * point of it is the comparison in `src/docs/skill.test.ts`: a variable this
 * finds that `SKILL.md` does not declare is a publishing problem, since
 * ClawHub's security review compares declared metadata against actual
 * behaviour.
 */
export function environmentVariablesRead(): Set<string> {
  const source = shippedSources()
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const found = new Set<string>();
  for (const match of source.matchAll(/env[.[]"?([A-Z][A-Z0-9_]{2,})"?\]?/g)) {
    if (!PLATFORM_VARIABLES.has(match[1]!)) {
      found.add(match[1]!);
    }
  }
  return found;
}

/**
 * Read by the code, but not settings of this skill and deliberately not
 * declared in `SKILL.md`'s `envVars`.
 *
 * `APPDATA` is set by Windows itself and is read in exactly one place
 * (`applicationDefaultCredentialsPath` in `src/auth/credentials.ts`) to work
 * out where gcloud writes its application-default credentials file. Declaring
 * it would put it in the Control UI as something a user is invited to set,
 * which is worse than leaving it out: nobody should set `APPDATA` for this
 * skill, and setting it wrongly breaks unrelated Windows software. It is
 * listed here, in one place, rather than being silently skipped by a loose
 * regex.
 *
 * **Why this exception is safe against the review that motivated the rule.**
 * The three-way match in `src/docs/skill.test.ts` exists because ClawHub's
 * security review compares declared metadata against actual behaviour: a
 * variable the code reads and the manifest does not admit to is a
 * discrepancy a reviewer is entitled to fail the listing over. What that
 * review is looking for is undeclared *input*: a setting that changes what
 * the skill does, where it sends data, or what it is allowed to read.
 * `APPDATA` is none of those. It is an operating-system-provided location,
 * consulted read-only to build one well-known path on one platform, and it
 * carries no user intent: the same code on Linux and macOS derives the same
 * path from `home` with no variable at all. Declaring it would answer the
 * review's question with something that is not an answer to it, and would
 * mislead every user who reads the manifest as a list of things to set. If a
 * reviewer ever asks, this comment is the reply.
 */
const PLATFORM_VARIABLES = new Set(["APPDATA"]);
