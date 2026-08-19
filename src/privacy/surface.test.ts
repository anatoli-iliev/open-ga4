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
 * `runAccessReport`. This skill does not call them. That claim is worth
 * something only if it is checked, so it is checked here, against `lib/`,
 * the committed compiled output, which is what actually ships to users.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, "../../lib");
const repoRoot = path.resolve(here, "../..");

/** Hosts the skill actually opens a connection to. The runtime guarantee is
 * enforced by assertAllowedUrl in ga4/http.ts and tested there; the scan
 * below is defence in depth against a hardcoded URL reaching the bundle
 * unreviewed. */
const CONTACTED = ["analyticsadmin.googleapis.com", "analyticsdata.googleapis.com", "oauth2.googleapis.com"];

/**
 * Hosts that appear only as text shown to a human: a link in a "here is how
 * to fix it" message, or the OAuth scope identifier. Never fetched. Adding to
 * this list is a deliberate, reviewable decision: README.md's egress
 * paragraph names every one of these verbatim, and the test below pins that
 * paragraph to this exact array, so the two cannot silently drift apart.
 */
const REFERENCED_ONLY = [
  "www.googleapis.com", // inside the analytics.readonly scope string
  "console.cloud.google.com", // "enable the API here" link in errors.ts
  "console.developers.google.com", // same link, as Google returns it in Help details
  "analytics.google.com", // Property access management link in setup/state.ts's no_property_grant state
];

async function readLibSources(): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".js")) {
        out.push({ file: path.relative(libDir, full), text: await readFile(full, "utf8") });
      }
    }
  }
  await walk(libDir);
  return out;
}

describe("the shipped bundle", () => {
  it("never references a per-user Google Analytics surface", async () => {
    const forbidden = ["audienceExport", "audienceList", "runAccessReport", "userDataRetention"];
    const offenders: string[] = [];

    for (const { file, text } of await readLibSources()) {
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
    for (const { text } of await readLibSources()) {
      for (const match of text.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.-]+/g)) {
        scopes.add(match[0]);
      }
    }
    expect([...scopes]).toEqual(["https://www.googleapis.com/auth/analytics.readonly"]);
  });

  it("mentions no URL that is neither contacted nor a documented signpost", async () => {
    const allowed = new Set([...CONTACTED, ...REFERENCED_ONLY]);
    const hosts = new Set<string>();
    for (const { text } of await readLibSources()) {
      for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        hosts.add(match[1]!.toLowerCase());
      }
    }

    expect([...hosts].filter((host) => !allowed.has(host))).toEqual([]);
  });

  it("keeps README.md's egress paragraph naming exactly these hosts", async () => {
    // Pins the paragraph the README publishes verbatim to CONTACTED and
    // REFERENCED_ONLY above, so the next addition to either array is
    // impossible to make without updating that prose in the same change:
    // the drift this repository has already suffered twice.
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const start = readme.indexOf("**An egress allowlist enforced in code.**");
    const end = readme.indexOf("**Read-only by scope.**");
    expect(start, "README.md's egress-allowlist bullet was not found").toBeGreaterThan(-1);
    expect(end, "README.md's read-only-by-scope bullet was not found").toBeGreaterThan(start);
    const paragraph = readme.slice(start, end);

    const named = new Set<string>();
    for (const match of paragraph.matchAll(/`([a-z0-9.-]+\.[a-z]{2,})`/gi)) {
      named.add(match[1]!.toLowerCase());
    }

    expect(named).toEqual(new Set([...CONTACTED, ...REFERENCED_ONLY]));
  });

  it("writes nothing to disk outside the audit log", async () => {
    const offenders: string[] = [];
    for (const { file, text } of await readLibSources()) {
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

  /**
   * ClawHub's review of 0.2.0 flagged `sudo timedatectl set-ntp true`, which the
   * clock-skew message used to hand over as a line to paste, as normalising the
   * habit of running an agent-suggested administrator command unread.
   *
   * The command itself is still named, in the message and in both documents: it
   * is the answer on Linux, and withholding it to satisfy a scanner would leave
   * a user stuck on a real problem. What changed is that it is offered rather
   * than prescribed, with what it needs (administrator rights) and whose job it
   * is (theirs) said out loud, and `sudo` is not written out for them.
   *
   * Checked against `lib/` rather than `src/`, because the message a user sees
   * comes from the built output, and checked across every file because the
   * string lived in two modules and would be easy to reintroduce in a third.
   * Nothing about the skill's behaviour depends on this: turning on automatic
   * time is a one-off operating-system setting that the skill never performs.
   */
  it("prescribes no privileged shell command anywhere in the built output", async () => {
    const offenders: string[] = [];
    for (const { file, text } of await readLibSources()) {
      for (const term of ["sudo ", "doas ", "runas "]) {
        if (text.includes(term)) {
          offenders.push(`${file} tells the user to run ${term.trim()}`);
        }
      }
    }
    expect(offenders, "offer a privileged command and say it needs rights; do not paste it")
      .toEqual([]);
  });

  it("still names the fix for a skewed clock, and says what it costs", async () => {
    // The point above is not to lose the answer. If this stops matching, the
    // message has been sanitised into uselessness rather than made safer.
    const sources = await readLibSources();
    const skew = sources.filter(({ text }) => text.includes("set-ntp true"));
    expect(skew.length, "the clock-skew fix should still be named").toBeGreaterThan(0);
    for (const { file, text } of skew) {
      expect(text, `${file} should say the command needs administrator rights`)
        .toMatch(/administrator rights/i);
    }
  });
});
