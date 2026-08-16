# Open GA4 Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repository from an OpenClaw plugin into a standalone OpenClaw skill called Open GA4, installable in one command by someone who has never opened a terminal.

**Architecture:** The existing analytics core (auth, GA4 client, privacy, formatting) is already host-independent and is kept verbatim. What changes is everything wrapped around it: the plugin entry is deleted, the typebox parameter schemas are replaced by a hand-written argv parser, a `lib/` of compiled JavaScript is committed so no install route needs a build, and a `SKILL.md` at the repository root turns the folder into a skill. Setup is driven by the agent through a `doctor --json` state machine that reports one blocking step at a time.

**Tech Stack:** TypeScript 5.9 compiled to ES modules on Node >=22.22.3, vitest for tests, zero runtime dependencies, GitHub Actions for CI, ClawHub for distribution.

**Spec:** [`docs/superpowers/specs/2026-08-16-open-ga4-design.md`](../specs/2026-08-16-open-ga4-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero runtime dependencies.** After Task 4, `package.json` has no `dependencies` and no `peerDependencies`. Only `devDependencies` (typescript, vitest) remain. A task that adds a runtime dependency has failed.
- **Node floor `>=22.22.3`.** Unchanged from today. CI matrix stays `['22', '24']`.
- **No em dashes** (U+2014) anywhere: code, comments, commit messages, documentation. Use a colon, a semicolon, parentheses, or a full stop. This is a standing repository rule.
- **Never invent a number.** No statistic is derived client-side that the API did not return. Percentiles in particular do not average.
- **Read-only stays structural.** The only OAuth scope is `https://www.googleapis.com/auth/analytics.readonly`. The egress allowlist stays `oauth2.googleapis.com`, `analyticsdata.googleapis.com`, `analyticsadmin.googleapis.com`. `src/privacy/surface.test.ts` asserts both against the built output and must keep passing.
- **Slug, repository and frontmatter name are all `open-ga4`.** Display name is `Open GA4`.
- **Licence is MIT-0** from Task 1 onward.
- **Privacy-weakening settings are environment variables, never CLI flags.** See the constraint below; it is the single most important rule in this plan.
- **Every PR is a feature branch, a pull request, and an admin-bypass squash merge.** Branch names are given per task group.

### The privacy constraint, stated once and applied everywhere

Four settings weaken the privacy defaults: turning redaction off, permitting
user-identifying dimensions, setting a property allowlist, and enabling the
audit log. Under the plugin these were **configuration**, which means a human
typed them. If they become command-line flags, the **model** can set them, and
a prompt-injected instruction in a page title could talk an agent into passing
`--allow-user-identifying-dimensions`.

Therefore: these four are read **only** from the environment, never from argv.
There is no flag for them and no flag may be added. `src/cli/args.ts` must fail
its own test if any of the four names appears in the flag table.

This is an amendment to the spec, whose D6 frontmatter listed four environment
variables. It lists eight after Task 11. The reason is recorded here and is
repeated in the spec in Task 11.

### Environment variables, complete and final

| Name | Read by | Purpose |
| --- | --- | --- |
| `GA4_CREDENTIALS` | `src/auth/credentials.ts` | Service-account JSON key: contents or a path |
| `GA4_PROPERTY_ID` | `src/config.ts` | Default numeric property id |
| `GOOGLE_APPLICATION_CREDENTIALS` | `src/auth/credentials.ts` | Google's standard variable, fallback |
| `GA4_REDACT` | `src/config.ts` | `0`/`false` turns redaction off. Human-set only. |
| `GA4_ALLOW_USER_DIMENSIONS` | `src/config.ts` | `1`/`true` permits `userId`. Human-set only. |
| `GA4_PROPERTY_ALLOWLIST` | `src/config.ts` | Comma-separated ids. Human-set only. |
| `GA4_AUDIT_LOG` | `src/config.ts` | Path for the append-only query log. Human-set only. |
| `NO_COLOR` | `src/cli/render.ts` | Any value disables colour |

Task 11 adds a test asserting this table, the frontmatter `envVars` block, and
the set of names the code actually reads are the same three-way match.

---

## File Structure

**Deleted:**

| Path | Why |
| --- | --- |
| `src/index.ts` | The plugin entry. Replaced by `src/cli/main.ts`. |
| `src/index.test.ts` | Tests the deleted entry against `openclaw.plugin.json`. |
| `openclaw.plugin.json` | The plugin manifest. Replaced by `SKILL.md` frontmatter. |
| `src/types.ts` | Exists only to widen the SDK's `AnyAgentTool`. |

**Created:**

| Path | Responsibility |
| --- | --- |
| `SKILL.md` | Frontmatter contract plus the agent's decision procedure. Repository root. |
| `src/cli/main.ts` | Entry point: dispatch, top-level error handling, exit codes. Nothing else. |
| `src/cli/args.ts` | argv to a typed, validated options object. No I/O, no network. |
| `src/cli/render.ts` | stdout and stderr writing, colour, `NO_COLOR`. The only module that writes to a stream. |
| `src/cli/exit.ts` | The exit-code enum and the error-to-code mapping. |
| `src/cli/commands/*.ts` | One file per command, each a thin adapter over an existing operation. |
| `src/setup/state.ts` | The `blocked_on` state machine behind `doctor --json`. |
| `src/docs/skill.test.ts` | Tests pinning `SKILL.md` and `README.md` to the code. |
| `scripts/build-lib.mjs` | Compiles `src/` to `lib/`, used by the build and the drift check. |
| `.github/workflows/release.yml` | Publishes to ClawHub on a GitHub release. |
| `lib/**` | Committed compiled output. Generated, never hand-edited. |

**Modified:**

| Path | Change |
| --- | --- |
| `src/config.ts` | Drop typebox. Resolve from environment rather than a plugin config object. |
| `src/tools/reports.ts` | Split each tool into a typebox-free operation plus its metadata. |
| `src/tools/discovery.ts` | Same, plus the `--json` path for `doctor`. |
| `src/runtime.ts` | Collapse `NO_CREDENTIALS` into `CREDENTIALS_MISSING`. |
| `src/ga4/errors.ts` | Receive the collapsed code; add `NO_PROPERTY` to the taxonomy. |
| `package.json` | Name, description, no dependencies, new scripts, no `openclaw` block. |
| `README.md`, `SETUP.md`, `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md` | Rename, and rewrite install and setup for a skill. |
| `LICENSE` | MIT to MIT-0. |
| `.github/workflows/ci.yml` | Add the `lib/` drift check. |
| `.github/CODEOWNERS` | Add `SKILL.md`, `src/cli/`, `src/setup/`, `lib/`. |

---

# PR 3: `feat/rename-open-ga4`

Renames the product everywhere and changes the licence. No behaviour changes, so the 277 existing tests must pass untouched at the end of this PR.

### Task 1: Rename to Open GA4 and relicense to MIT-0

**Files:**
- Modify: `package.json`, `LICENSE`, `README.md`, `SETUP.md`, `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/DESIGN.md`, `openclaw.plugin.json`, `.github/CODEOWNERS`
- Test: `src/docs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the strings `open-ga4` (slug) and `Open GA4` (display name), used by every later task.

- [ ] **Step 1: Write the failing test**

Add to `src/docs.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    for (const file of ["README.md", "SETUP.md", "PRIVACY.md", "SECURITY.md", "CONTRIBUTING.md"]) {
      expect(readFileSync(file, "utf8")).not.toContain("openclaw-plugin-ga4");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/docs.test.ts -t "project identity"`
Expected: FAIL, four failures, the first reading `expected 'openclaw-plugin-ga4' to be 'open-ga4'`.

- [ ] **Step 3: Replace LICENSE with MIT-0**

```
MIT No Attribution

Copyright 2026 Anatoli Iliev

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The MIT-0 text has no "the above copyright notice shall be included" paragraph. That absence is the entire difference; do not paste MIT and delete a line by hand, use the text above.

- [ ] **Step 4: Update package.json identity fields**

```json
{
  "name": "open-ga4",
  "version": "0.1.0",
  "description": "Open GA4: read-only, privacy-respecting Google Analytics 4 answers for an OpenClaw agent.",
  "license": "MIT-0",
  "repository": { "type": "git", "url": "git+https://github.com/anatoli-iliev/open-ga4.git" },
  "homepage": "https://github.com/anatoli-iliev/open-ga4#readme",
  "bugs": { "url": "https://github.com/anatoli-iliev/open-ga4/issues" },
  "private": true
}
```

`"private": true` is added deliberately: this is not going to npm, and the flag makes an accidental `npm publish` fail rather than succeed.

- [ ] **Step 5: Rewrite the documentation headers and prose**

In `README.md`, `SETUP.md`, `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md` and `docs/DESIGN.md`, replace:

| Old | New |
| --- | --- |
| `openclaw-plugin-ga4` | `open-ga4` |
| `GA4 Analytics` (as the product name) | `Open GA4` |
| "the plugin" | "the skill" |
| `plugins.entries.ga4.config.` | `skills.entries.open-ga4.` |

Do **not** yet rewrite the install instructions; PR 7 does that once `SKILL.md` exists. Leave a single line in `README.md` under Install reading:

```markdown
Install instructions are rewritten in the skill packaging change; see
[the design spec](docs/superpowers/specs/2026-08-16-open-ga4-design.md).
```

Read each surrounding paragraph after replacing, do not trust the substitution. A find-and-replace in this repository has twice corrected a sentence and left the table beneath it wrong.

- [ ] **Step 6: Add the new paths to CODEOWNERS**

Append to `.github/CODEOWNERS`, before the final `/.github/CODEOWNERS` line:

```
# The skill contract the agent reads, and the command line it drives.
/SKILL.md                       @anatoli-iliev
/src/cli/                       @anatoli-iliev
/src/setup/                     @anatoli-iliev

# Generated, never hand-edited. CI fails on any drift from src/.
/lib/                           @anatoli-iliev
```

These patterns match nothing until later tasks create the paths, which GitHub reports as a warning rather than an error. Verify with `gh api "repos/anatoli-iliev/open-ga4/codeowners/errors?ref=<branch>"` returning `{"errors":[]}` after the repository rename.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, 281 tests (277 existing plus the four new identity tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Rename the project to Open GA4 and relicense to MIT-0

ClawHub relicenses what it hosts to MIT-0, so shipping MIT meant the licence
a user received was not the licence in the repository. MIT-0 drops the
attribution requirement, which is a deliberate giveaway.

The name changes because the category is crowded: ga4, ga4-analytics,
google-analytics and ten more are taken, so a keyword name would also be an
indistinguishable name. Open is the honest contrast with listings that route
data through a hosted server or that can write through the Admin API.

Install instructions are deliberately left stale for one more change; they are
rewritten once SKILL.md exists and there is something true to write."
```

- [ ] **Step 9: Rename the GitHub repository**

This is not a commit, so it cannot be part of the pull request. Do it after the pull request merges:

```bash
gh repo rename open-ga4 --repo anatoli-iliev/openclaw-plugin-ga4 --yes
git remote set-url origin https://github.com/anatoli-iliev/open-ga4.git
git remote -v          # confirm both fetch and push moved
gh repo view --json name,url
```

GitHub redirects the old URL, so existing clones keep working. Confirm the redirect rather than assume it: `git ls-remote https://github.com/anatoli-iliev/openclaw-plugin-ga4.git` should still resolve.

---

# PR 4: `feat/drop-plugin-sdk`

Removes typebox and the `openclaw` dependency, leaving zero runtime dependencies. The tool logic is untouched; only the schema layer around it changes.

### Task 2: Resolve configuration from the environment, without typebox

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts` (create)

**Interfaces:**
- Consumes: `RedactionOptions` from `src/privacy/redact.js`, `AccessPolicy` from `src/privacy/policy.js`, `LIMITS` from `src/ga4/limits.js`.
- Produces: `configFromEnv(env: NodeJS.ProcessEnv, onWarning?: (m: string) => void): ResolvedConfig`. `ResolvedConfig` keeps its existing shape exactly, so `src/runtime.ts` needs no change. `Ga4PluginConfig`, `configSchema` and `resolveConfig` are deleted.

- [ ] **Step 1: Write the failing test**

Create `src/config.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "./config.js";

describe("configFromEnv", () => {
  it("defaults to redaction on and user dimensions blocked", () => {
    const config = configFromEnv({});
    expect(config.redaction.enabled).toBe(true);
    expect(config.access.allowUserIdentifyingDimensions).toBe(false);
    expect(config.access.propertyAllowlist).toEqual([]);
    expect(config.auditLogPath).toBeUndefined();
  });

  it("reads the property id", () => {
    expect(configFromEnv({ GA4_PROPERTY_ID: "123456789" }).defaultPropertyId).toBe("123456789");
  });

  it("turns redaction off only for an explicit false value", () => {
    expect(configFromEnv({ GA4_REDACT: "0" }).redaction.enabled).toBe(false);
    expect(configFromEnv({ GA4_REDACT: "false" }).redaction.enabled).toBe(false);
    expect(configFromEnv({ GA4_REDACT: "" }).redaction.enabled).toBe(true);
    expect(configFromEnv({ GA4_REDACT: "yes please" }).redaction.enabled).toBe(true);
  });

  it("permits user dimensions only for an explicit true value", () => {
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "1" }).access.allowUserIdentifyingDimensions).toBe(true);
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "true" }).access.allowUserIdentifyingDimensions).toBe(true);
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "0" }).access.allowUserIdentifyingDimensions).toBe(false);
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "maybe" }).access.allowUserIdentifyingDimensions).toBe(false);
  });

  it("splits the property allowlist and drops empty entries", () => {
    expect(configFromEnv({ GA4_PROPERTY_ALLOWLIST: "111, 222 ,,333" }).access.propertyAllowlist)
      .toEqual(["111", "222", "333"]);
  });

  it("warns and continues when GA4_PROPERTY_ALLOWLIST holds a non-numeric id", () => {
    const warn = vi.fn();
    const config = configFromEnv({ GA4_PROPERTY_ALLOWLIST: "111,not-an-id" }, warn);
    expect(config.access.propertyAllowlist).toEqual(["111"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not-an-id"));
  });

  it("uses the default row limit when unset", () => {
    expect(configFromEnv({}).defaultRowLimit).toBeGreaterThan(0);
  });
});
```

The two "only for an explicit value" tests are the point of this task. A truthiness check on an environment variable would make `GA4_REDACT=0` turn redaction **on**, because `"0"` is a non-empty string. That is a privacy failure that reads as a typo.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL with `configFromEnv is not a function` or an import error.

- [ ] **Step 3: Rewrite src/config.ts**

Delete the `typebox` import, `configSchema`, `Ga4PluginConfig` and `resolveConfig` entirely. Replace with:

```ts
import { DEFAULT_KEPT_QUERY_PARAMS, type RedactionOptions } from "./privacy/redact.js";
import { DEFAULT_ACCESS_POLICY, type AccessPolicy } from "./privacy/policy.js";
import { LIMITS } from "./ga4/limits.js";

/**
 * Settings, resolved from the environment.
 *
 * Everything here is read from the process environment and never from argv.
 * That is deliberate for the four privacy settings: a command-line flag can be
 * set by the model, and a page title is attacker-controlled text that reaches
 * the model. An environment variable is set by a person.
 */
export type ResolvedConfig = {
  credentialsPath?: string;
  defaultPropertyId?: string;
  defaultRowLimit: number;
  redaction: RedactionOptions;
  access: AccessPolicy;
  auditLogPath?: string;
};

/** True only for "1", "true", "yes" and "on", case-insensitively. */
function isTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** False only for "0", "false", "no" and "off". Anything else leaves the default. */
function isFalse(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function configFromEnv(
  env: NodeJS.ProcessEnv,
  onWarning?: (message: string) => void,
): ResolvedConfig {
  const allowlist: string[] = [];
  for (const raw of (env.GA4_PROPERTY_ALLOWLIST ?? "").split(",")) {
    const id = raw.trim();
    if (id === "") continue;
    if (!/^[0-9]+$/.test(id)) {
      onWarning?.(
        `Ignoring GA4_PROPERTY_ALLOWLIST entry ${JSON.stringify(id)}: a property id is the ` +
          "9 or 10 digit number from Admin > Property details, not the G-XXXXXXXXXX measurement id.",
      );
      continue;
    }
    allowlist.push(id);
  }

  return {
    credentialsPath: undefined,
    defaultPropertyId: env.GA4_PROPERTY_ID?.trim() || undefined,
    defaultRowLimit: LIMITS.DEFAULT_ROWS,
    redaction: {
      enabled: !isFalse(env.GA4_REDACT),
      keepQueryParams: DEFAULT_KEPT_QUERY_PARAMS,
      extraPatterns: [],
    },
    access: {
      ...DEFAULT_ACCESS_POLICY,
      allowUserIdentifyingDimensions: isTrue(env.GA4_ALLOW_USER_DIMENSIONS),
      propertyAllowlist: allowlist,
    },
    auditLogPath: env.GA4_AUDIT_LOG?.trim() || undefined,
  };
}
```

`credentialsPath` stays `undefined` here because credential resolution moves wholly into `src/auth/credentials.ts` in Task 3, where `GA4_CREDENTIALS` can hold contents as well as a path and only that module knows how to tell them apart.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the two privacy tests**

Change `enabled: !isFalse(env.GA4_REDACT)` to `enabled: env.GA4_REDACT !== undefined ? Boolean(env.GA4_REDACT) : true` and run the suite. Expected: the `GA4_REDACT=0` assertion FAILS. Revert. If it passes, the test is decoration and must be strengthened before continuing.

Repeat for `allowUserIdentifyingDimensions`: change `isTrue(...)` to `Boolean(env.GA4_ALLOW_USER_DIMENSIONS)` and confirm the `"0"` and `"maybe"` assertions fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "Resolve settings from the environment instead of plugin config

Drops typebox from config.ts. The schema existed to describe a
plugins.entries.ga4.config block, and a skill has no such block.

The four privacy settings are read only from the environment and deliberately
have no command-line flag. A flag can be set by the model, and dimension values
are written by site visitors, so a page title is a channel for talking an agent
into weakening redaction. An environment variable is set by a person.

Truthiness is not used. GA4_REDACT=0 is a non-empty string and would turn
redaction on under a Boolean() check, which is a privacy failure that reads as
a typo. Explicit true and false word lists instead, mutation-checked."
```

### Task 3: Accept the key as contents or a path

**Files:**
- Modify: `src/auth/credentials.ts:149-190`
- Test: `src/auth/credentials.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveCredentials` gains `GA4_CREDENTIALS` as its highest-priority source, accepting inline JSON. Its return type is unchanged, so `src/runtime.ts` is unaffected. A new probe label `"GA4_CREDENTIALS (pasted key)"` or `"GA4_CREDENTIALS (file)"` appears in `probes()`.

- [ ] **Step 1: Write the failing test**

Add to `src/auth/credentials.test.ts`:

```ts
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "demo",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
  client_email: "reader@demo.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});

describe("GA4_CREDENTIALS", () => {
  it("accepts the key's contents inline", async () => {
    const result = await resolveCredentials({ env: { GA4_CREDENTIALS: SERVICE_ACCOUNT } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.kind).toBe("service_account");
    expect(result.credential.account.clientEmail).toBe("reader@demo.iam.gserviceaccount.com");
  });

  it("tolerates leading whitespace before the opening brace", async () => {
    const result = await resolveCredentials({ env: { GA4_CREDENTIALS: `\n  ${SERVICE_ACCOUNT}` } });
    expect(result.ok).toBe(true);
  });

  it("accepts a path when the value is not JSON", async () => {
    const file = join(tmpdir(), `open-ga4-${process.pid}.json`);
    writeFileSync(file, SERVICE_ACCOUNT);
    try {
      const result = await resolveCredentials({ env: { GA4_CREDENTIALS: file } });
      expect(result.ok).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("reports malformed inline JSON without echoing the value", async () => {
    const result = await resolveCredentials({ env: { GA4_CREDENTIALS: '{"private_key":"secret' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const probe = result.probes.find((p) => p.label.startsWith("GA4_CREDENTIALS"));
    expect(probe?.status).toBe("invalid");
    expect(JSON.stringify(result.probes)).not.toContain("secret");
  });

  it("takes priority over GOOGLE_APPLICATION_CREDENTIALS", async () => {
    const result = await resolveCredentials({
      env: { GA4_CREDENTIALS: SERVICE_ACCOUNT, GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent.json" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probes[0]?.label).toContain("GA4_CREDENTIALS");
  });
});
```

The fourth test is the one that matters. `resolveCredentials` reports what it tried, and a malformed pasted key is a string that contains a private key. Echoing the offending value into a probe detail is how a credential reaches a terminal, an agent's context, and a model provider.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/credentials.test.ts -t "GA4_CREDENTIALS"`
Expected: FAIL, all five, because `GA4_CREDENTIALS` is not consulted.

- [ ] **Step 3: Implement**

In `src/auth/credentials.ts`, before the existing `candidates` array, add the inline branch:

```ts
const inline = options.env?.GA4_CREDENTIALS?.trim();
if (inline !== undefined && inline !== "") {
  if (inline.startsWith("{")) {
    try {
      const credential = parseCredentialJson(inline);
      probes.push({ label: "GA4_CREDENTIALS (pasted key)", path: "(inline)", status: "used" });
      return { ok: true, credential, probes };
    } catch (error) {
      // Deliberately does not include the value, or any excerpt of it. A
      // malformed pasted key is still a private key.
      probes.push({
        label: "GA4_CREDENTIALS (pasted key)",
        path: "(inline)",
        status: "invalid",
        detail: "the value starts with { but is not valid service-account JSON",
      });
      return { ok: false, probes };
    }
  }
  candidates.unshift({ label: "GA4_CREDENTIALS (file)", path: expandHome(inline, home) });
}
```

`parseCredentialJson` is the existing parser the file already applies to file contents; extract it if it is currently inline in the read path, so exactly one parser exists.

Return early on malformed inline JSON rather than falling through to the other sources. Someone who pasted a key and got it wrong wants to hear that the pasted key is wrong, not that gcloud credentials are also absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/auth/credentials.test.ts`
Expected: PASS, 19 tests (14 existing plus 5).

- [ ] **Step 5: Mutation-check the redaction test**

Add `detail: String(error)` to the invalid branch. Expected: the "without echoing the value" test FAILS. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/auth/credentials.ts src/auth/credentials.test.ts
git commit -m "Accept GA4_CREDENTIALS as the key's contents or a path to it

The person setting this up has just clicked download in the Google Cloud
console and has a file in ~/Downloads. Move it, chmod it, and type its path is
three chances to fail; paste it into a labelled box is one. The value is read
as JSON when it starts with a brace and as a path otherwise.

Malformed inline JSON reports that it is malformed and stops, without quoting
any part of the value: a broken pasted key is still a private key, and probe
details are printed to a terminal and read by a model. Malformed also does not
fall through to the other sources, because someone who pasted a key wants to
hear about the key they pasted."
```

### Task 4: Delete the plugin entry and every npm dependency

**Files:**
- Delete: `src/index.ts`, `src/index.test.ts`, `src/types.ts`, `openclaw.plugin.json`
- Modify: `src/tools/reports.ts`, `src/tools/discovery.ts`, `package.json`, `tsconfig.json`, `tsconfig.check.json`
- Test: `src/privacy/surface.test.ts` (must keep passing unchanged)

**Interfaces:**
- Consumes: `configFromEnv` from Task 2.
- Produces: each former tool factory becomes an operation with a plain TypeScript parameter type and no `parameters` field:

```ts
export type ReportParams = {
  report: string;
  property_id?: string;
  date_range?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  filter?: string;
};
export function runReport(runtime: Ga4Runtime, params: ReportParams, signal?: AbortSignal):
  Promise<{ markdown: string; details: unknown }>;
```

and equivalently `CompareParams`/`runCompare`, `RealtimeParams`/`runRealtime`, `QueryParams`/`runQuery`, `FieldsParams`/`runFields`, `DiagnoseParams`/`runDiagnose`. Parameter property names are kept snake_case, identical to the current typebox schemas, so no call site inside the tool bodies changes.

- [ ] **Step 1: Confirm the current suite is green before restructuring**

Run: `npm test`
Expected: PASS. Record the count. Restructuring on top of a red suite hides which failure you caused.

- [ ] **Step 2: Convert one tool and prove nothing moved**

Start with `reportTool` in `src/tools/reports.ts:118`. Keep the whole body of `execute` byte-identical; only change the wrapper:

```ts
// Before
export function reportTool(runtime: Ga4Runtime) {
  return {
    name: "ga4_report",
    label: "GA4 report",
    description: "...",
    parameters: Type.Object({ /* ... */ }),
    async execute(params: ..., signal?: AbortSignal) { /* BODY */ },
  };
}

// After
export type ReportParams = {
  report: string;
  property_id?: string;
  date_range?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  filter?: string;
};

export async function runReport(
  runtime: Ga4Runtime,
  params: ReportParams,
  signal?: AbortSignal,
): Promise<{ markdown: string; details: unknown }> {
  /* BODY, unchanged */
}
```

Take the property names and optionality from the typebox object being deleted, one for one. Do not take the opportunity to rename anything.

- [ ] **Step 3: Run the existing tool tests**

Run: `npx vitest run src/tools/reports.test.ts`
Expected: FAIL only where the test calls `reportTool(runtime).execute(...)`. Update those call sites to `runReport(runtime, ...)`. Expected after: PASS, same test count as before. A changed count means behaviour moved.

- [ ] **Step 4: Repeat for the remaining five**

`compareTool`, `realtimeTool`, `queryTool` in `src/tools/reports.ts`; `fieldsTool`, `diagnoseTool` in `src/tools/discovery.ts`. After each one, run that file's tests before moving on.

- [ ] **Step 5: Delete the plugin surface**

```bash
git rm src/index.ts src/index.test.ts src/types.ts openclaw.plugin.json
```

`src/types.ts` exists only to widen the SDK's tool type. Grep for importers first: `grep -rn "types.js" src/` must return nothing before the delete is safe.

- [ ] **Step 6: Empty the dependency lists**

In `package.json`, delete the `dependencies`, `peerDependencies` and `openclaw` blocks entirely. `devDependencies` keeps only `typescript` and `vitest`. Then:

```bash
rm -rf node_modules package-lock.json
npm install
```

- [ ] **Step 7: Write the failing test that keeps it that way**

Add to `src/docs.test.ts`:

```ts
it("ships no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;
  expect(pkg.dependencies ?? {}).toEqual({});
  expect(pkg.peerDependencies ?? {}).toEqual({});
});

it("imports nothing outside node: builtins", () => {
  const files = globSync("src/**/*.ts").filter((f) => !f.endsWith(".test.ts"));
  const offenders: string[] = [];
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = match[1]!;
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      offenders.push(`${file}: ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});
```

The second test is the one that holds the line. A `dependencies: {}` check passes happily while a source file imports `typebox` that happens to be present as a transitive development dependency.

- [ ] **Step 8: Run everything**

Run: `npm test`
Expected: PASS. `src/privacy/surface.test.ts` must pass **unchanged**: it asserts the egress allowlist and the read-only scope against the built output, and it is the check that the restructuring did not widen the network surface.

- [ ] **Step 9: Mutation-check the import test**

Add `import { Type } from "typebox";` to the top of `src/ga4/limits.ts`. Expected: the "imports nothing outside node: builtins" test FAILS naming that file. Revert.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Delete the plugin entry and every runtime dependency

typebox was imported in three files and only ever to build tool parameter
schemas and the plugin config schema. Both existed to satisfy the plugin API,
so both die with it. What is left imports nothing but node: builtins.

That is not a vanity number. It is what makes install-and-it-runs true: there
is no node_modules to be missing and no install step that can fail.

Each tool factory becomes a plain function with a TypeScript parameter type.
The execute bodies are moved byte for byte and the parameter names are kept
snake_case exactly as the typebox schemas had them, so the test counts per file
are unchanged. A changed count would have meant behaviour moved.

Accepted cost, recorded in the spec as D1: resultContentSource is reachable
only through the plugin registration API and goes away. The fenced data block
that actually separates visitor-authored text from trusted output lives in the
formatter and is untouched."
```

---

# PR 5: `feat/cli`

### Task 5: Argument parsing and exit codes

**Files:**
- Create: `src/cli/exit.ts`, `src/cli/args.ts`, `src/cli/args.test.ts`, `src/cli/exit.test.ts`
- Test: as above

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// src/cli/exit.ts
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  BAD_INPUT: 2,
  SETUP_INCOMPLETE: 3,
  GOOGLE_REFUSED: 4,
} as const;
export function exitCodeFor(error: unknown): number;

// src/cli/args.ts
export type ParsedArgs =
  | { kind: "help"; command?: string }
  | { kind: "version" }
  | { kind: "command"; command: string; positional: string[]; flags: Record<string, string | boolean> };
export function parseArgs(argv: string[]): ParsedArgs;
export class UsageError extends Error { constructor(message: string); }
export const FORBIDDEN_FLAGS: readonly string[];
```

- [ ] **Step 1: Write the failing test**

Create `src/cli/args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FORBIDDEN_FLAGS, parseArgs, UsageError } from "./args.js";

describe("parseArgs", () => {
  it("reads a command and its positional argument", () => {
    expect(parseArgs(["report", "top_pages"])).toEqual({
      kind: "command", command: "report", positional: ["top_pages"], flags: {},
    });
  });

  it("accepts hyphens where the preset id uses underscores", () => {
    const parsed = parseArgs(["report", "top-pages"]);
    expect(parsed).toMatchObject({ positional: ["top_pages"] });
  });

  it("reads --flag value and --flag=value identically", () => {
    expect(parseArgs(["report", "overview", "--limit", "5"]).flags).toEqual({ limit: "5" });
    expect(parseArgs(["report", "overview", "--limit=5"]).flags).toEqual({ limit: "5" });
  });

  it("treats a bare --flag as true", () => {
    expect(parseArgs(["doctor", "--json"]).flags).toEqual({ json: true });
  });

  it("rejects an unknown flag by name", () => {
    expect(() => parseArgs(["report", "overview", "--lmit", "5"]))
      .toThrow(/--lmit/);
  });

  it("rejects a flag that would weaken privacy", () => {
    for (const flag of FORBIDDEN_FLAGS) {
      expect(() => parseArgs(["report", "overview", `--${flag}`]))
        .toThrow(/set by a person|environment variable/i);
    }
  });

  it("throws UsageError, never a bare Error", () => {
    expect(() => parseArgs(["nonsense"])).toThrow(UsageError);
  });

  it("understands --help with and without a command", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["report", "--help"])).toEqual({ kind: "help", command: "report" });
  });

  it("stops flag parsing after --", () => {
    expect(parseArgs(["fields", "--", "--weird-field-name"]))
      .toMatchObject({ positional: ["--weird-field-name"] });
  });
});
```

`FORBIDDEN_FLAGS` is the enforcement of the global privacy constraint. The test iterates it, so adding a name to the list without implementing the rejection fails.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/args.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement src/cli/exit.ts**

```ts
import { Ga4Error } from "../ga4/errors.js";

export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  BAD_INPUT: 2,
  SETUP_INCOMPLETE: 3,
  GOOGLE_REFUSED: 4,
} as const;

/** Codes that mean "you have not finished setting this up", not "Google said no". */
const SETUP_CODES = new Set([
  "CREDENTIALS_MISSING",
  "CREDENTIALS_REJECTED",
  "CLOCK_SKEW",
  "DATA_API_DISABLED",
  "ADMIN_API_DISABLED",
  "SERVICE_DISABLED",
  "NO_PROPERTY_ACCESS",
  "NO_PROPERTY",
  "PROPERTY_NOT_FOUND",
]);

export function exitCodeFor(error: unknown): number {
  if (error instanceof Ga4Error) {
    if (SETUP_CODES.has(error.code)) return EXIT.SETUP_INCOMPLETE;
    if (error.code === "INVALID_REQUEST") return EXIT.BAD_INPUT;
    return EXIT.GOOGLE_REFUSED;
  }
  return EXIT.UNEXPECTED;
}
```

Splitting 3 from 4 is the whole point: "you have not finished setting this up" and "Google refused a request you are entitled to make" call for different conversations, and collapsing them is how a setup problem gets reported to a user as an outage.

- [ ] **Step 4: Implement src/cli/args.ts**

```ts
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const COMMANDS = ["doctor", "report", "compare", "live", "query", "fields", "properties"] as const;

/**
 * Names that must never become flags.
 *
 * These four settings weaken the privacy defaults. A flag can be set by the
 * model, and dimension values are authored by site visitors, so a page title is
 * a channel for talking an agent into passing one. They are environment
 * variables so that a person sets them.
 */
export const FORBIDDEN_FLAGS = [
  "redact", "no-redact",
  "allow-user-dimensions", "allow-user-identifying-dimensions",
  "property-allowlist",
  "audit-log",
] as const;

const KNOWN_FLAGS: Record<string, readonly string[]> = {
  doctor: ["json"],
  report: ["property", "range", "start", "end", "limit", "filter", "json"],
  compare: ["property", "range", "against", "limit", "filter", "json"],
  live: ["property", "limit", "json"],
  query: ["property", "dimensions", "metrics", "range", "start", "end", "limit", "filter", "sort", "json"],
  fields: ["property", "kind", "json"],
  properties: ["json"],
};

export type ParsedArgs =
  | { kind: "help"; command?: string }
  | { kind: "version" }
  | { kind: "command"; command: string; positional: string[]; flags: Record<string, string | boolean> };

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] === "--version" || argv[0] === "-V") return { kind: "version" };

  const command = argv[0]!;
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(
      `unknown command ${JSON.stringify(command)}. Valid commands are: ${COMMANDS.join(", ")}.`,
    );
  }

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const allowed = KNOWN_FLAGS[command]!;
  let literal = false;

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (literal) { positional.push(token); continue; }
    if (token === "--") { literal = true; continue; }
    if (token === "--help" || token === "-h") return { kind: "help", command };

    if (!token.startsWith("--")) { positional.push(normalizeId(token)); continue; }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);

    if ((FORBIDDEN_FLAGS as readonly string[]).includes(name)) {
      throw new UsageError(
        `--${name} is not a flag. It changes a privacy default, so it is set by a person ` +
          `through an environment variable, not by an agent on a command line. ` +
          `See the Privacy section of SKILL.md.`,
      );
    }
    if (!allowed.includes(name)) {
      throw new UsageError(
        `unknown option --${name} for ${command}. Valid options are: ` +
          `${allowed.map((f) => `--${f}`).join(", ")}.`,
      );
    }

    if (eq !== -1) { flags[name] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { flags[name] = true; continue; }
    flags[name] = next;
    i += 1;
  }

  return { kind: "command", command, positional, flags };
}

/** Preset ids are snake_case; a model writes hyphens more often than underscores. */
function normalizeId(value: string): string {
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(value) ? value.replaceAll("-", "_") : value;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/cli/args.test.ts src/cli/exit.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-check the forbidden-flag guard**

Delete the `FORBIDDEN_FLAGS` block from `parseArgs`. Expected: "rejects a flag that would weaken privacy" FAILS for all six names. Revert. If it still passes, the names are being caught only by the unknown-flag branch, which produces the wrong message and would start permitting them the moment someone adds one to `KNOWN_FLAGS`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/
git commit -m "Add argument parsing and the exit-code taxonomy

Exit 3 (setup incomplete) is deliberately distinct from exit 4 (Google
refused). Collapsing them is how an unfinished setup gets reported to a user as
an outage, and they call for completely different conversations.

parseArgs rejects six flag names outright, with a message explaining that they
are environment variables because a person sets them and an agent does not. The
test iterates the list, so adding a name without implementing its rejection
fails. Mutation-checked: removing the guard must break the test, otherwise the
names are only being caught by the unknown-flag branch and would be permitted
the moment one appeared in the known-flag table.

Hyphens are normalised to underscores in positional ids. Preset ids are
snake_case and a model writes report top-pages far more often than
report top_pages; failing on that would be a self-inflicted wound."
```

### Task 6: The entry point and the seven commands

**Files:**
- Create: `src/cli/main.ts`, `src/cli/render.ts`, `src/cli/main.test.ts`
- Test: `src/cli/main.test.ts`

**Interfaces:**
- Consumes: `parseArgs`, `EXIT`, `exitCodeFor` from Task 5; `runReport`, `runCompare`, `runRealtime`, `runQuery`, `runFields`, `runDiagnose` from Task 4; `configFromEnv` from Task 2; `createRuntime` from `src/runtime.js`.
- Produces:

```ts
export type Streams = { out: (s: string) => void; err: (s: string) => void };
export async function main(argv: string[], env: NodeJS.ProcessEnv, streams: Streams): Promise<number>;
```

`main` returns an exit code and never calls `process.exit`, so it is testable. The `lib/cli.js` shim is the only thing that exits.

- [ ] **Step 1: Write the failing test**

Create `src/cli/main.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { main } from "./main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, streams: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe("main", () => {
  it("prints usage and exits 0 for --help", async () => {
    const c = capture();
    expect(await main(["--help"], {}, c.streams)).toBe(0);
    expect(c.out.join("")).toContain("open-ga4");
    expect(c.err.join("")).toBe("");
  });

  it("exits 2 and names the offending option", async () => {
    const c = capture();
    expect(await main(["report", "overview", "--lmit", "5"], {}, c.streams)).toBe(2);
    expect(c.err.join("")).toContain("--lmit");
    expect(c.out.join("")).toBe("");
  });

  it("exits 3 with no credentials configured", async () => {
    const c = capture();
    expect(await main(["report", "overview"], {}, c.streams)).toBe(3);
    expect(c.err.join("")).toMatch(/credential/i);
  });

  it("never prints a stack trace", async () => {
    const c = capture();
    await main(["report", "overview"], {}, c.streams);
    expect(c.err.join("")).not.toContain("    at ");
  });

  it("lists every command in --help", async () => {
    const c = capture();
    await main(["--help"], {}, c.streams);
    for (const command of ["doctor", "report", "compare", "live", "query", "fields", "properties"]) {
      expect(c.out.join("")).toContain(command);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/main.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement src/cli/render.ts**

```ts
export type Streams = { out: (s: string) => void; err: (s: string) => void };

export function colorEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NO_COLOR === undefined || env.NO_COLOR === "";
}

export const processStreams: Streams = {
  out: (s) => { process.stdout.write(s); },
  err: (s) => { process.stderr.write(s); },
};
```

- [ ] **Step 4: Implement src/cli/main.ts**

```ts
import { configFromEnv } from "../config.js";
import { diagnose } from "../ga4/errors.js";
import { redactText } from "../privacy/redact.js";
import { createRuntime } from "../runtime.js";
import { runCompare, runQuery, runRealtime, runReport } from "../tools/reports.js";
import { runDiagnose, runFields, runProperties } from "../tools/discovery.js";
import { parseArgs, UsageError } from "./args.js";
import { EXIT, exitCodeFor } from "./exit.js";
import type { Streams } from "./render.js";

const USAGE = `open-ga4: read-only Google Analytics 4 answers.

Usage: node <skill-dir>/lib/cli.js <command> [options]

Commands:
  doctor [--json]            Check setup and report the one thing to fix next
  report <preset>            One ready-made report
  compare <preset>           The same report across two periods
  live                       Active users in roughly the last 30 minutes
  query                      Explicit dimensions, metrics, filters and sort
  fields <search>            Search the property's live field catalog
  properties                 List the properties this credential can read

Run a command with --help for its options.
Settings live in the environment; see SKILL.md.
`;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  streams: Streams,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    streams.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.BAD_INPUT;
  }

  if (parsed.kind === "help") { streams.out(USAGE); return EXIT.OK; }
  if (parsed.kind === "version") { streams.out(`${VERSION}\n`); return EXIT.OK; }

  const warnings: string[] = [];
  const config = configFromEnv(env, (m) => warnings.push(m));
  const runtime = createRuntime({ config, env, onWarning: (m) => warnings.push(m) });

  try {
    const result = await dispatch(runtime, parsed, env);
    for (const warning of warnings) streams.err(`warning: ${warning}\n`);
    streams.out(result.endsWith("\n") ? result : `${result}\n`);
    return EXIT.OK;
  } catch (error) {
    // Never let a traceback reach the user: it names the wrong problem. The
    // taxonomy already maps every known failure to a sentence with a fix, and
    // redactText keeps a credential out of the message on every path.
    const named = diagnose(error, { principal: runtime.principal() });
    streams.err(`error: ${redactText(named.toString())}\n`);
    return exitCodeFor(named);
  }
}
```

`dispatch` is a `switch` over `parsed.command` that converts `flags` into each operation's parameter object and returns `result.markdown`. Write it in this same file; it is a dozen lines and splitting it across a file boundary hides the mapping that reviewers most need to see.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/cli/main.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Mutation-check the traceback guard**

Replace the `catch` body with `streams.err(String((error as Error).stack)); return 1;`. Expected: "never prints a stack trace" FAILS. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/cli/
git commit -m "Add the command line over the existing operations

main returns an exit code and never calls process.exit, so every path is
testable, including the failures. The shim in lib/ is the only thing that
exits.

No traceback ever reaches the user. A stack trace names the import line rather
than the real problem, which is usually that setup is unfinished. Every error
goes through the existing taxonomy, which maps it to a sentence with a fix, and
then through redactText, so a credential cannot ride out on an error path."
```

---

# PR 6: `feat/doctor-json`

### Task 7: Collapse the duplicate credentials-missing code

**Files:**
- Modify: `src/runtime.ts:61`, `src/ga4/errors.ts`
- Test: `src/ga4/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NO_CREDENTIALS` no longer exists. `CREDENTIALS_MISSING` is the single code. `NO_PROPERTY` is added to the taxonomy's known set so `exitCodeFor` maps it deliberately rather than by fallthrough.

- [ ] **Step 1: Write the failing test**

```ts
it("has exactly one code for missing credentials", () => {
  const sources = ["src/runtime.ts", "src/ga4/errors.ts", "src/auth/credentials.ts"]
    .map((f) => readFileSync(f, "utf8")).join("\n");
  expect(sources).not.toContain("NO_CREDENTIALS");
  expect(sources).toContain("CREDENTIALS_MISSING");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ga4/errors.test.ts -t "exactly one code"`
Expected: FAIL, because `src/runtime.ts:61` raises `NO_CREDENTIALS`.

- [ ] **Step 3: Implement**

In `src/runtime.ts`, change `new Ga4Error("NO_CREDENTIALS", ...)` to `new Ga4Error("CREDENTIALS_MISSING", ...)`. Update the hint text to name the skill's own settings rather than the plugin's:

```ts
throw new Ga4Error(
  "CREDENTIALS_MISSING",
  `No Google credentials found. Locations checked:\n${checked}`,
  "Save your service-account key as GA4_CREDENTIALS: paste the file's contents, or give " +
    "its path. Run `doctor` for a step-by-step check of what is still missing.",
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. Two existing tests referencing `NO_CREDENTIALS` will need their expectation updated; that is the intended blast radius.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Collapse NO_CREDENTIALS into CREDENTIALS_MISSING

Two codes for one condition, raised from runtime.ts and errors.ts. The setup
state machine in the next change keys on these codes, and two codes for one
state is how a state machine acquires a branch that can never be reached.

The hint now names GA4_CREDENTIALS instead of a plugins.entries config path
that no longer exists."
```

### Task 8: `doctor --json` returns one blocking step

**Files:**
- Create: `src/setup/state.ts`, `src/setup/state.test.ts`
- Modify: `src/tools/discovery.ts` (the `runDiagnose` body), `src/cli/main.ts` (dispatch)
- Test: `src/setup/state.test.ts`

**Interfaces:**
- Consumes: `Check[]` as already produced by `runDiagnose`, and `Ga4Error.code`.
- Produces:

```ts
export type BlockedOn =
  | "ok" | "no_credentials" | "bad_credentials" | "clock_skew"
  | "data_api_disabled" | "admin_api_disabled" | "no_property_grant"
  | "no_property_selected" | "wrong_property" | "quota";

export type SetupState = {
  ok: boolean;
  blocked_on: BlockedOn;
  principal?: string;
  next?: { where: string; action: string; paste?: string; role?: string };
  url?: string;
  properties?: Array<{ id: string; name: string }>;
};

export function setupStateFrom(checks: Check[], principal?: string): SetupState;
export const BLOCKED_ON_VALUES: readonly BlockedOn[];
```

- [ ] **Step 1: Write the failing test**

Create `src/setup/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BLOCKED_ON_VALUES, setupStateFrom } from "./state.js";

const pass = (label: string) => ({ label, status: "pass" as const, detail: "" });
const fail = (label: string, code: string) => ({ label, status: "fail" as const, detail: "", code });

describe("setupStateFrom", () => {
  it("reports ok when every check passes", () => {
    const state = setupStateFrom([pass("Google credentials"), pass("Data API report")]);
    expect(state).toMatchObject({ ok: true, blocked_on: "ok" });
    expect(state.next).toBeUndefined();
  });

  it("returns only the FIRST failure, not all of them", () => {
    const state = setupStateFrom([
      fail("Google credentials", "CREDENTIALS_MISSING"),
      fail("Admin API and property access", "NO_PROPERTY_ACCESS"),
      fail("Data API report", "DATA_API_DISABLED"),
    ]);
    expect(state.blocked_on).toBe("no_credentials");
    expect(JSON.stringify(state)).not.toContain("no_property_grant");
  });

  it("hands back the exact string to paste for a missing grant", () => {
    const state = setupStateFrom(
      [pass("Google credentials"), fail("Admin API and property access", "NO_PROPERTY_ACCESS")],
      "reader@demo.iam.gserviceaccount.com",
    );
    expect(state.blocked_on).toBe("no_property_grant");
    expect(state.next?.paste).toBe("reader@demo.iam.gserviceaccount.com");
    expect(state.next?.role).toBe("Viewer");
    expect(state.url).toContain("analytics.google.com");
  });

  it("distinguishes a measurement id from a missing property", () => {
    expect(setupStateFrom([fail("Property selection", "PROPERTY_NOT_FOUND")]).blocked_on)
      .toBe("wrong_property");
    expect(setupStateFrom([fail("Property selection", "NO_PROPERTY")]).blocked_on)
      .toBe("no_property_selected");
  });

  it("treats a missing Admin API as non-blocking when reports still work", () => {
    const state = setupStateFrom([
      pass("Google credentials"),
      fail("Admin API and property access", "ADMIN_API_DISABLED"),
      pass("Data API report"),
    ]);
    expect(state.ok).toBe(true);
    expect(state.blocked_on).toBe("ok");
  });

  it("never emits a blocked_on value outside the declared set", () => {
    for (const code of ["CREDENTIALS_MISSING", "CLOCK_SKEW", "QUOTA_EXHAUSTED", "UNEXPECTED"]) {
      expect(BLOCKED_ON_VALUES).toContain(setupStateFrom([fail("x", code)]).blocked_on);
    }
  });
});
```

The second test is the design. A user handed five simultaneous problems does nothing; a user handed one does it. The fifth is the subtle one: the Admin API only affects listing properties by name, so a report that works while it is disabled is a working setup, and reporting it as broken sends people to fix something that does not matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/setup/state.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement src/setup/state.ts**

Map each error code to a state and a next action, in dependency order, returning at the first failure. `ADMIN_API_DISABLED` is skipped rather than returned when a later Data API check passes. Console URLs must be on hosts already in the egress allowlist or in the reviewed text-only list in `src/privacy/surface.test.ts`; adding a new host to a printed link requires updating that test's list deliberately.

- [ ] **Step 4: Wire `--json` into dispatch**

In `src/cli/main.ts`, when `command === "doctor"` and `flags.json` is true, return `JSON.stringify(setupStateFrom(details.checks, runtime.principal()), null, 2)`. Otherwise return the existing markdown checklist.

`doctor` exits 0 even when setup is incomplete: it succeeded at diagnosing. Exit 3 is for a **report** command that could not run. Add a test asserting `main(["doctor", "--json"], {}, streams)` returns 0 with no credentials configured.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Mutation-check the first-failure rule**

Change `setupStateFrom` to return the **last** failure instead of the first. Expected: "returns only the FIRST failure" FAILS. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/setup/ src/cli/ src/tools/discovery.ts
git commit -m "Add doctor --json, reporting one blocking step at a time

The markdown checklist is right for a person reading a terminal and wrong for
an agent guiding somebody through setup: it answers what is wrong, when the
useful question is what to do next. --json answers the second one, returning a
single blocked_on value, a link, and the exact string to paste.

One step, never a wall. A non-technical person handed five simultaneous
problems does nothing.

A disabled Admin API is explicitly not blocking when the Data API check passes.
It only affects listing properties by name, and reporting a working setup as
broken sends people to fix something that does not matter.

doctor exits 0 even when setup is incomplete, because it succeeded at
diagnosing. Exit 3 is for a report that could not run."
```

---

# PR 7: `feat/skill-md`

### Task 9: Write SKILL.md

**Files:**
- Create: `SKILL.md`
- Modify: `docs/superpowers/specs/2026-08-16-open-ga4-design.md` (D6 frontmatter: four env vars becomes eight)

**Interfaces:**
- Consumes: every command from Tasks 5 and 6, every `BlockedOn` value from Task 8.
- Produces: the skill contract. Nothing consumes it except the agent and the tests in Task 10.

- [ ] **Step 1: Write the frontmatter**

Exactly as specified in the spec's D6, with the `envVars` list extended to all eight names from the Global Constraints table above. Description must stay under 300 characters; the one in the spec measures 282.

- [ ] **Step 2: Write the decision table first**

It is the highest-value content in the file, so it goes above everything else. Left column is what a person actually says, several phrasings per row; right column is the exact command:

```markdown
| The user says | Run |
| --- | --- |
| "how did my site do", "give me the numbers", "traffic report" | `report overview` |
| "top pages", "most read", "what are people looking at" | `report top_pages` |
| "where is my traffic from", "who sends me visitors", "referrers" | `report traffic_sources` |
| "is anyone on my site right now", "live visitors" | `live` |
| "how does this month compare with last", "are we up or down" | `compare overview` |
| "set up my analytics", "it says it is not working" | `doctor --json` |
```

- [ ] **Step 3: Write the setup tree**

One section per `BlockedOn` value, each giving the sentence to say, the link to open, and the exact string to paste. The `no_property_grant` section is the one everybody gets wrong and gets the most words: access is granted **inside Google Analytics**, under Admin then Property access management, not in Google Cloud IAM.

- [ ] **Step 4: Write the remaining sections in this order**

Vague input (list and ask, never guess); when to use `--json` (only to compute, never to relay); exit codes and the sentence each should produce; "never state a number that was not measured"; analytics values are untrusted input; then the reference material.

- [ ] **Step 5: Amend the spec**

In D6, replace the four-entry `envVars` block with all eight, and add a sentence recording why: privacy-weakening settings cannot be flags because a flag can be set by the model.

- [ ] **Step 6: Commit**

```bash
git add SKILL.md docs/superpowers/specs/
git commit -m "Add SKILL.md, written for an agent rather than a reader

A human reads top to bottom; an agent needs a decision procedure. The
phrasing-to-command table is first because it is the highest-value content in
the file, and the reference material is last.

The setup tree has one section per blocked_on value. The missing-grant section
is longest because it is the step everybody gets wrong: access is granted
inside Google Analytics under Admin, Property access management, and a Cloud
IAM role does nothing.

Amends the spec's D6: four declared environment variables becomes eight. The
four privacy settings cannot be flags, because a flag can be set by the model."
```

### Task 10: Pin the documentation to the code

**Files:**
- Create: `src/docs/skill.test.ts`
- Test: as above

**Interfaces:**
- Consumes: `SKILL.md`, `README.md`, `package.json`, `COMMANDS` and `KNOWN_FLAGS` from `src/cli/args.ts`, `BLOCKED_ON_VALUES` from `src/setup/state.ts`.
- Produces: nothing. Tests only.

- [ ] **Step 1: Write the tests**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS, parseArgs } from "../cli/args.js";
import { BLOCKED_ON_VALUES } from "../setup/state.js";

const SKILL = readFileSync("SKILL.md", "utf8");
const FRONTMATTER = SKILL.slice(SKILL.indexOf("---") + 3, SKILL.indexOf("\n---", 3));

describe("SKILL.md is pinned to the code", () => {
  it("keeps the description short enough to render in one table cell", () => {
    const match = /description: >-\n((?:\s{2}.*\n)+)/.exec(FRONTMATTER);
    const description = match![1]!.replace(/\s+/g, " ").trim();
    expect(description.length).toBeLessThan(300);
  });

  it("declares name, slug and repository as the same string", () => {
    expect(FRONTMATTER).toContain("name: open-ga4");
    expect(FRONTMATTER).toContain("anatoli-iliev/open-ga4");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };
    expect(pkg.name).toBe("open-ga4");
    expect(FRONTMATTER).toContain(`version: ${pkg.version}`);
  });

  it("requires nothing in requires.env", () => {
    expect(FRONTMATTER).not.toMatch(/requires:[\s\S]*?\n\s+env:/);
  });

  it("documents every command, and no command that does not exist", () => {
    const documented = [...SKILL.matchAll(/`(?:node <skill-dir>\/lib\/cli\.js )?([a-z]+)[^`]*`/g)]
      .map((m) => m[1]!).filter((c) => (COMMANDS as readonly string[]).includes(c));
    expect(new Set(documented)).toEqual(new Set(COMMANDS));
  });

  it("documents every blocked_on value, and no value the code cannot emit", () => {
    for (const value of BLOCKED_ON_VALUES) expect(SKILL).toContain(value);
    for (const match of SKILL.matchAll(/`(no_[a-z_]+|bad_[a-z_]+|wrong_[a-z_]+)`/g)) {
      expect(BLOCKED_ON_VALUES).toContain(match[1]);
    }
  });

  it("runs every command it quotes", () => {
    for (const match of SKILL.matchAll(/^\| .* \| `([^`]+)` \|$/gm)) {
      expect(() => parseArgs(match[1]!.split(/\s+/))).not.toThrow();
    }
  });

  it("declares every environment variable the code reads, and reads every one it declares", () => {
    const declared = [...FRONTMATTER.matchAll(/- name: ([A-Z0-9_]+)/g)].map((m) => m[1]!);
    const source = globSync("src/**/*.ts").filter((f) => !f.includes(".test."))
      .map((f) => readFileSync(f, "utf8")).join("\n");
    const read = [...source.matchAll(/env[.\[]"?([A-Z][A-Z0-9_]{2,})"?\]?/g)].map((m) => m[1]!);
    expect(new Set(declared)).toEqual(new Set(read));
  });
});
```

The last test is not documentation hygiene. ClawHub's security review compares declared metadata against actual behaviour, so an environment variable the code reads and does not declare is a publishing problem.

- [ ] **Step 2: Run and fix**

Run: `npx vitest run src/docs/skill.test.ts`
Expected: FAIL on first run, most likely the command-coverage test. Fix `SKILL.md`, not the test, unless the test's regex is genuinely wrong.

- [ ] **Step 3: Mutation-check**

Delete one command's row from the decision table. Expected: "documents every command" FAILS. Restore. Add `process.env.GA4_SECRET_THING` to `src/config.ts`. Expected: the declaration test FAILS. Revert.

- [ ] **Step 4: Commit**

```bash
git add src/docs/
git commit -m "Pin SKILL.md to the code with tests

Documentation drifts silently and a careful reader is not a control. These
assert that every command is documented and no documented command is invented,
that every blocked_on value appears in the setup tree and no invented one does,
that every quoted command actually parses, and that the declared environment
variables and the ones the code reads are the same set.

The last is not hygiene. ClawHub's security review compares declared metadata
against actual behaviour, so a variable the code reads and does not declare is
a publishing problem rather than a documentation one."
```

---

# PR 8: `feat/ship-lib`

### Task 11: Commit the compiled output and fail CI on drift

**Files:**
- Create: `scripts/build-lib.mjs`, `lib/**` (generated)
- Modify: `package.json` scripts, `.gitignore`, `.github/workflows/ci.yml`, `tsconfig.json`

**Interfaces:**
- Consumes: all source.
- Produces: `lib/cli.js` as the documented entry point.

- [ ] **Step 1: Point the build at lib/ and stop ignoring it**

In `tsconfig.json` set `"outDir": "lib"`. In `.gitignore` remove `dist/` and add nothing in its place; `lib/` is tracked deliberately. Add to `package.json`:

```json
{
  "scripts": {
    "build": "node scripts/build-lib.mjs",
    "check:lib": "node scripts/build-lib.mjs --check"
  }
}
```

- [ ] **Step 2: Write scripts/build-lib.mjs**

It compiles `src/` to a temporary directory, strips `*.test.js` and `*.test.d.ts`, appends the `#!/usr/bin/env node` shim and `process.exit(await main(process.argv.slice(2), process.env, processStreams))` to `lib/cli.js`, and then either copies over `lib/` or, with `--check`, diffs and exits 1 on any difference, printing the differing paths.

- [ ] **Step 3: Write the failing test**

```ts
it("ships no compiled tests", () => {
  expect(globSync("lib/**/*.test.js")).toEqual([]);
});

it("has a runnable entry point", () => {
  expect(existsSync("lib/cli.js")).toBe(true);
});
```

- [ ] **Step 4: Build, commit the output, and verify it runs**

```bash
npm run build
node lib/cli.js --help          # must print usage and exit 0
node lib/cli.js doctor --json   # must print JSON and exit 0
git add lib/
```

- [ ] **Step 5: Add the drift check to CI**

In `.github/workflows/ci.yml`, after the Build step, replace the existing "Assert dist/ ships no compiled tests" step with:

```yaml
      - name: Assert lib/ matches a fresh build of src/
        run: |
          set -euo pipefail
          npm run check:lib
          if [ -n "$(git status --porcelain lib/)" ]; then
            echo "::error::lib/ is not a clean build of src/. Run npm run build and commit."
            git --no-pager diff --stat lib/
            exit 1
          fi
          echo "lib/ matches src/"

      - name: Assert lib/ ships no compiled tests
        run: |
          set -euo pipefail
          leaked="$(find lib -type f -name '*.test.js')"
          if [ -n "$leaked" ]; then
            echo "::error::lib/ contains compiled test files:"; echo "$leaked"; exit 1
          fi
```

- [ ] **Step 6: Mutation-check the drift check**

Edit one character in a `lib/` file and run `npm run check:lib`. Expected: exit 1, naming that file. Revert with `npm run build`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Commit lib/ and fail CI on any drift from src/

Committing build output is normally bad practice. It is bought here with a CI
job that rebuilds from source and fails on a single byte of difference, so the
two cannot diverge.

The reason it has to be committed is that no install route runs a build:
ClawHub copies files, git: clones, and a local path is a directory copy. An
uncommitted lib/ means openclaw skills install git:... produces a folder that
does not run, and that is a documented, supported route.

One readable file per source module rather than a bundle. ClawHub's security
review reads the shipped code, and a several thousand line generated file makes
the reviewer's job worse for no user benefit."
```

---

# PR 9: `feat/release`

### Task 12: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the workflow**

Triggered on `release: types: [published]` only, never on push. It checks out the tag, runs `npm ci && npm run check && npm run check:lib`, then publishes with an **absolute** path:

```yaml
      - name: Publish to ClawHub
        env:
          CLAWHUB_TOKEN: ${{ secrets.CLAWHUB_TOKEN }}
        run: |
          set -euo pipefail
          npx clawhub@0.23.3 skill publish "$GITHUB_WORKSPACE" \
            --slug open-ga4 --name "Open GA4" \
            --version "${GITHUB_REF_NAME#v}" --tags latest \
            --source-repo "$GITHUB_REPOSITORY" \
            --source-ref "$GITHUB_REF_NAME" \
            --source-commit "$GITHUB_SHA" \
            --changelog "$(gh release view "$GITHUB_REF_NAME" --json body -q .body)"
```

`"$GITHUB_WORKSPACE"`, never `.`. `clawhub` resolves a relative folder against its own workdir, which falls back to the OpenClaw workspace when the current directory has no `.clawhub/` marker, so `publish .` publishes the wrong directory and reports `SKILL.md required` about a directory nobody named.

The workflow stays inert until a `CLAWHUB_TOKEN` secret is deliberately configured, matching the existing comment at the bottom of `ci.yml`.

- [ ] **Step 2: Check the bundle manifest before the first real publish**

```bash
npx clawhub@0.23.3 skill publish "$PWD" --slug open-ga4 --name "Open GA4" \
  --version 1.0.0 --dry-run --json
```

Read `fileCount`. The packer excludes dotfiles and `.github/`, so `.gitignore` and `CODEOWNERS` do not reach ClawHub; confirm `SKILL.md`, `lib/`, `README.md`, `SETUP.md`, `PRIVACY.md`, `SECURITY.md` and `LICENSE` do. Do **not** read `latestVersion` as a name-availability signal: it reports `null` for slugs that demonstrably exist.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml CHANGELOG.md
git commit -m "Add the ClawHub release workflow

Fires on a published release and never on a push. A publish workflow that can
fire on a push is a foot-gun: one bad merge and a broken build is on the
registry forever.

Publishes an absolute path. clawhub resolves a relative folder against its own
workdir, which silently falls back to the OpenClaw workspace when the current
directory has no .clawhub marker, so publish . uploads the wrong directory and
then reports SKILL.md required about a directory nobody named.

source-repo, source-ref and source-commit tie the listing to an exact commit,
so a reader can diff what is published against what is on GitHub. For anything
that asks a user for a credential, that is worth doing."
```

### Task 13: Install the published artifact and use it as a new user

This is the highest-yield check in the plan and the one people skip. Everything before it tested the source tree; this is the only thing that tests what a user receives.

- [ ] **Step 1: Publish, then wait without polling expensively**

Publishing is asynchronous. Poll with `clawhub skill verify open-ga4 --version X.Y.Z`, which returns in about a second. **Never** poll with `clawhub scan`: it queues a new scan on every invocation and blocks for minutes. Print a timestamp on each check and read it; a delay you have not observed is a delay you do not have.

`{"ok": false, "reasons": ["card.missing"]}` immediately after publishing is normal. The skill card is generated server-side on its own schedule and affects only how the page renders. Do nothing about it. `review.llm_review` is a scan in flight, not a reviewer's objection.

- [ ] **Step 2: Install into a scratch workspace and run it cold**

```bash
export OPENCLAW_STATE_DIR=$(mktemp -d)
openclaw skills install @anatoli-iliev/open-ga4
openclaw skills check | grep open-ga4          # must say ready
SKILL_DIR=$(openclaw skills info open-ga4 | sed -n 's/.*Path: \(.*\)\/SKILL.md/\1/p')
node "$SKILL_DIR/lib/cli.js" --help            # must print usage, exit 0
node "$SKILL_DIR/lib/cli.js" doctor --json     # must print blocked_on, exit 0
ls -l "$SKILL_DIR/lib/cli.js"                  # the mode does not matter; node is invoked directly
```

Run this with nothing from the development machine on hand: no `node_modules`, no checkout, no environment variables set.

- [ ] **Step 3: Walk the setup tree from nothing**

With no credentials configured, ask an agent, in a non-technical person's words, "set up my website analytics". Follow only what it says. Every step must be doable from a browser. Record where it stalls; a stall is a bug in `SKILL.md`, not in the person.

- [ ] **Step 4: One live call per unpinned shape**

Against a real property, run `report overview`, `report top_pages`, `compare overview`, `live`, `fields sessions` and `properties`. Compare each figure with the Google Analytics web UI for the same range and property time zone. A number that differs is a defect even when nothing failed: a well-formatted wrong number is the worst outcome available.

- [ ] **Step 5: Record what was actually verified**

Update `CHANGELOG.md` with the version, the date, and which of the above were run against a live property. Do not write "tested" where "not run" is true.

---

## Self-Review

**Spec coverage.** D1 Task 4; D2 Task 1; D3 Task 4; D4 Task 11; D5 Tasks 6 and 11; D6 Task 9; D7 Tasks 2 and 9; D8 Task 3; D9 Tasks 7 and 8; D10 Tasks 5 and 6; D11 Task 5; D12 Task 1. Test plan Tasks 2 through 11. Release Tasks 12 and 13. No gaps.

**Amendment to the spec.** D6 declared four environment variables; this plan declares eight, because the four privacy settings must be human-set rather than model-set. Task 9 Step 5 writes the amendment back into the spec so the two do not disagree.

**Type consistency.** `ResolvedConfig` keeps its exact current shape through Task 2, so `src/runtime.ts` compiles untouched. Operation parameter types stay snake_case, matching the typebox schemas they replace, so tool bodies do not change. `Streams` is defined in `src/cli/render.ts` and imported by `main.ts`, not redeclared. `BlockedOn` and `BLOCKED_ON_VALUES` are exported from one place and consumed by both the CLI and the docs tests.

**Known risk not eliminated.** Task 4 moves six `execute` bodies. The mitigation is that per-file test counts must not change; a changed count means behaviour moved rather than code.
