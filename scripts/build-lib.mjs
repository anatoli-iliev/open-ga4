#!/usr/bin/env node
/**
 * Builds lib/ from src/.
 *
 * No install route runs a build: ClawHub copies files, `openclaw skills
 * install git:...` clones, and a local path is a directory copy. So lib/ has
 * to be committed, and this script is what proves the committed copy still
 * matches src/ rather than being a hand edit or a forgotten rebuild.
 *
 * Always compiles into a fresh temporary directory with the project's own
 * tsconfig.json (only the outDir is overridden), then strips what a shipped
 * bundle must never contain: compiled tests (*.test.js, *.test.d.ts) and
 * anything that came from src/testing/ (test-support code; tsconfig.json's
 * own exclude already keeps it out of compilation, this is defence in
 * depth). Then it writes lib/cli.js, the shim that makes
 * `node <skill-dir>/lib/cli.js <command>` work.
 *
 * Without --check: the temporary tree replaces lib/ outright.
 * With --check: the temporary tree is diffed against the committed lib/ and
 * nothing is written; any difference exits 1, naming every differing path.
 *
 * Only node: builtins and the typescript devDependency are used here, and
 * nothing here is a bundler: every compiled file keeps the same name and the
 * same position relative to lib/ that its source module has relative to
 * src/. A several-thousand-line generated file would make ClawHub's security
 * review worse for no user benefit, and a rewritten import graph is a second
 * thing to get right.
 *
 * Reproducible by construction: the only inputs are src/ and the pinned
 * typescript version, and nothing written here (including the shim, a fixed
 * string) embeds a timestamp or an absolute path. Running this twice against
 * the same source produces byte-identical output.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libDir = path.join(repoRoot, "lib");
const check = process.argv.includes("--check");

/**
 * The entry-point shim. Not compiled from a TypeScript source file: it is
 * three lines of wiring around the compiled cli/main.js and cli/render.js,
 * and giving it its own source module would only add a file whose entire
 * content is this. src/cli/main.ts's `main` returns an exit code rather than
 * calling `process.exit` itself, so this shim is the only place in the
 * shipped code that sets one.
 *
 * `process.exitCode`, never `process.exit()`. `process.exit()` terminates the
 * process at once and takes two things down with it, both verified:
 *
 * 1. The opt-in audit log. src/tools/reports.ts starts the append and does not
 *    await it (a log line is not worth delaying an answer for), so
 *    `process.exit()` killed the write before it reached the filesystem: the
 *    log file existed and stayed empty run after run. A privacy feature that
 *    silently records nothing is worse than one that is absent.
 * 2. Output over about 1 MiB, whenever stdout is a pipe, which is exactly how
 *    an agent captures it. Writes to a pipe are asynchronous, so 2,000,001
 *    bytes followed by `process.exit(0)` delivered 1,048,576 bytes and exit
 *    code 0: a silently truncated report that still looks like a success.
 *    `query --limit 1000` with a few dimensions reaches that size.
 *
 * Setting `exitCode` lets Node exit on its own once the event loop drains,
 * which flushes both. Nothing here holds the loop open beyond that:
 * `AbortSignal.timeout` in src/ga4/http.ts is unref'd by construction, so the
 * process still exits promptly. src/cli/shim.test.ts runs this shim as a child
 * process and asserts both behaviours.
 */
const CLI_SHIM = `#!/usr/bin/env node
import { main } from "./cli/main.js";
import { processStreams } from "./cli/render.js";

process.exitCode = await main(process.argv.slice(2), process.env, processStreams);
`;

/** Every file under `dir`, recursed into subdirectories. Never fs.globSync. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function relFilesSorted(dir) {
  if (!existsSync(dir)) return [];
  return walk(dir)
    .map((file) => path.relative(dir, file))
    .sort();
}

/** Compiles src/ into outDir, then strips compiled tests and anything from
 * src/testing/, and adds the cli.js shim. */
function compileInto(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  execFileSync(
    process.execPath,
    [path.join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", outDir],
    { cwd: repoRoot, stdio: "inherit" },
  );

  for (const file of walk(outDir)) {
    const rel = path.relative(outDir, file);
    const segments = rel.split(path.sep);
    const isCompiledTest = file.endsWith(".test.js") || file.endsWith(".test.d.ts");
    const isFromTesting = segments.includes("testing");
    if (isCompiledTest || isFromTesting) {
      rmSync(file, { force: true });
    }
  }

  writeFileSync(path.join(outDir, "cli.js"), CLI_SHIM);
}

/** Every difference between a fresh build and the committed lib/: a file the
 * fresh build produced that lib/ is missing or disagrees with, byte for
 * byte, and a file lib/ has that a fresh build no longer produces (a stale
 * artifact from a source file that was since deleted or renamed). */
function diff(freshDir, committedDir) {
  const fresh = new Set(relFilesSorted(freshDir));
  const committed = new Set(relFilesSorted(committedDir));
  const offenders = [];

  for (const rel of fresh) {
    if (!committed.has(rel)) {
      offenders.push(`missing from lib/: ${rel}`);
    } else if (!readFileSync(path.join(freshDir, rel)).equals(readFileSync(path.join(committedDir, rel)))) {
      offenders.push(`differs from a fresh build: ${rel}`);
    }
  }
  for (const rel of committed) {
    if (!fresh.has(rel)) {
      offenders.push(`stale in lib/, not produced by a fresh build: ${rel}`);
    }
  }
  return offenders.sort();
}

const tempDir = mkdtempSync(path.join(tmpdir(), "open-ga4-lib-"));
try {
  compileInto(tempDir);

  if (!check) {
    rmSync(libDir, { recursive: true, force: true });
    mkdirSync(libDir, { recursive: true });
    cpSync(tempDir, libDir, { recursive: true });
    console.log("Built lib/ from src/.");
  } else {
    const offenders = diff(tempDir, libDir);
    if (offenders.length > 0) {
      console.error("lib/ does not match a fresh build of src/:");
      for (const offender of offenders) {
        console.error(`  ${offender}`);
      }
      process.exitCode = 1;
    } else {
      console.log("lib/ matches a fresh build of src/.");
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
