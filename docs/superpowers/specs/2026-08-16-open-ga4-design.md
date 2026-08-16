# Design: Open GA4, a standalone OpenClaw skill

Status: accepted · 2026-08-16

Supersedes the packaging half of [`docs/DESIGN.md`](../../DESIGN.md), which
described this project as an OpenClaw plugin. The analytics decisions in that
document (D2 through D8) still hold and are not restated here. Decision D1,
"package shape: `definePluginEntry`", is reversed by this document.

## Problem

`openclaw-plugin-ga4` works, and almost nobody can use it. It installs as an
OpenClaw plugin, which means cloning a repository, running `npm install` and
`npm run build`, then hand-editing `openclaw.json` to add a `plugins.entries`
block. Every one of those steps is a step a non-technical person does not take.

The audience for "how many people visited my site last month" is not the
audience for a TypeScript build. The packaging is the barrier, not the code.

## Goals

1. A person who has never opened a terminal can install this and get an answer.
2. Installation is one command and requires no build, no `npm install`, and no
   hand-edited configuration file.
3. Google's setup, which is eight console steps and has one step that everybody
   gets wrong, is driven by the agent in conversation, one step at a time.
4. Every privacy and read-only claim inherited from the plugin survives intact
   and stays covered by a test.
5. The listing earns attention in a category that already has a dozen entries.

## Non-goals

- Publishing to npm. The skill is not a library and nobody should `npm install`
  it. The npm package name is abandoned, not renamed.
- Keeping the plugin working in parallel. This is a replacement (see D1).
- Writing to Google Analytics. Read-only by construction, unchanged.
- Supporting Universal Analytics. Shut down; the API is gone.

## Decisions

### D1. The skill replaces the plugin

The repository stops shipping an OpenClaw plugin and starts shipping an
OpenClaw skill: a folder with `SKILL.md` at its root and runnable JavaScript
beside it.

Deleted: `src/index.ts`, `openclaw.plugin.json`, the `openclaw` peer and dev
dependency, and the `openclaw/plugin-sdk` import in `src/types.ts`.

**Accepted cost.** `resultContentSource: "network"` is only reachable through
the plugin registration API, so the host-level marker for externally controlled
content goes away. What actually protects a reader today does not: report rows
are still rendered inside a fenced block introduced as visitor-supplied data,
with `|` escaped and newlines collapsed in every cell, and that lives in
`src/ga4/format.ts`. The newest released host, 2026.7.1-2, does not read
`resultContentSource` at all, so present-day behaviour is unchanged. What is
given up is a label that would have taken effect on a future host upgrade. This
is recorded here so it is a decision rather than an oversight.

### D2. Named Open GA4, slug `open-ga4`

The category is crowded. A ClawHub search returns `ga4`, `ga4-analytics`,
`ga4-connector`, `ga4-data-api`, `google-analytics`, `google-analytics-api`,
`google-analytics-cli`, `google-analytics-mcp`, `google-analytics-reporting`,
`google-analytics-ga4`, `native-google-analytics`, `oo-google-analytics` and
`skill-ga4-analytics`. Every obvious keyword name is gone, so a keyword name
would also be an indistinguishable name.

"Open" is the honest contrast with what those listings describe about
themselves: several route data through managed OAuth or a hosted MCP server,
several require Python plus `google-analytics-data`, and at least one is
write-capable through the Admin API. This one runs on the user's machine, talks
only to Google, and cannot write. Keeping `ga4` in the slug preserves the search
term.

A ClawHub search for `open-ga4` returns nothing, which is evidence the slug is
free but not proof; occupancy is only certain at publish time. Note that
`clawhub skill publish --dry-run --json` is **not** a usable availability check:
it reported `latestVersion: null` for `ga4`, a slug that demonstrably exists, so
that field reflects versions published by the caller rather than global
occupancy.

Renamed together, so all three agree: GitHub repository `open-ga4`, ClawHub slug
`open-ga4`, frontmatter `name: open-ga4`. A test asserts they match.

### D3. Zero runtime dependencies

`typebox` is imported in exactly three files (`src/config.ts`,
`src/tools/discovery.ts`, `src/tools/reports.ts`) and only ever to build tool
`parameters` schemas and the plugin config schema. Both exist to satisfy the
plugin API, and both die with D1.

The skill therefore ships with **no npm dependencies at all**, only Node
built-ins. This is not a vanity metric: it is what makes "install and it runs"
true, because there is no `node_modules` to be missing and no install step that
can fail. It also strengthens the auditability claim the README already makes,
from one dependency to none.

### D4. Committed build output, held honest by a test

TypeScript source does not run. Something runnable must be in the installed
folder, and no install route runs a build:

| Route | Runs a build? |
| --- | --- |
| `openclaw skills install @anatoli-iliev/open-ga4` | No, ClawHub copies files |
| `openclaw skills install git:anatoli-iliev/open-ga4` | No, git clone only |
| `openclaw skills install /path/to/clone` | No, directory copy only |

So `lib/` is compiled from `src/` and committed, one readable file per source
module, mapping 1:1 onto the source tree. Committing build output is normally
bad practice; it is bought here with a CI job that rebuilds from source and
fails if the committed output differs by a single byte, so the two cannot drift.

Rejected: a single bundled file. It removes the 1:1 correspondence with the
source, and ClawHub's security review reads the shipped code, so a several
thousand line generated file makes the reviewer's job worse for no user benefit.

Rejected: building in CI and never committing. It leaves
`openclaw skills install git:...`, a documented and supported route, producing a
folder that does not run.

### D5. Invoke the interpreter, never a launcher script

The documented command is:

```
node <skill-dir>/lib/cli.js <command> [options]
```

Not `<skill-dir>/bin/open-ga4`. ClawHub's installer drops the executable bit: a
file that is `100755` in git arrives `-rw-r--r--`, and a launcher that is not
executable is a skill that does not run. Invoking `node` directly means the bit
never matters.

`<skill-dir>` is resolved by the agent. When it does not already know the path,
`openclaw skills info open-ga4` prints it as
`Path: ~/.openclaw/workspace/skills/open-ga4/SKILL.md`, verified against a real
install. `SKILL.md` documents that fallback so the agent is never stuck, and the
path is never hardcoded, because a `--global` install lands in the shared
managed directory instead.

### D6. The frontmatter contract

```yaml
---
name: open-ga4
description: >-
  Answers questions about your website traffic from Google Analytics 4: top
  pages, where visitors came from, what changed since last month, who is on the
  site right now. Read only, runs on your machine, no Python. Ask "how many
  visitors did I get last week" or "top pages last month".
version: 1.0.0
homepage: https://github.com/anatoli-iliev/open-ga4
metadata:
  openclaw:
    requires:
      bins: [node]
    primaryEnv: GA4_CREDENTIALS
    envVars:
      - name: GA4_CREDENTIALS
        required: false
        description: >-
          The service-account JSON key, either its contents or a path to the
          file. This is the one thing most people need to set.
      - name: GA4_PROPERTY_ID
        required: false
        description: >-
          Default property, the 9 or 10 digit number from Admin > Property
          details. Not the G-XXXXXXXXXX measurement id. Without it the skill
          lists the readable properties and asks which one.
      - name: GOOGLE_APPLICATION_CREDENTIALS
        required: false
        description: >-
          Google's standard variable, read as a fallback so an existing gcloud
          setup keeps working.
      - name: NO_COLOR
        required: false
        description: Set to any value to disable coloured output.
      - name: GA4_REDACT
        required: false
        description: >-
          Set to 0, false, no or off to turn off redaction of dimension values.
      - name: GA4_ALLOW_USER_DIMENSIONS
        required: false
        description: >-
          Set to 1, true, yes or on to allow userId, signedInWithUserId and
          user-scoped custom dimensions, which are refused by default.
      - name: GA4_PROPERTY_ALLOWLIST
        required: false
        description: >-
          Comma-separated numeric property ids. When set, every other property
          is refused.
      - name: GA4_AUDIT_LOG
        required: false
        description: >-
          Path to a local JSON-lines log of what was asked, never what came
          back. Off unless set.
    emoji: "📈"
    homepage: https://github.com/anatoli-iliev/open-ga4
---
```

**Eight declared variables, not four.** The last four are the settings that weaken a
privacy default, and each of them is an environment variable precisely so that a
*person* sets it: a command-line flag can be set by the model, and a page title is
attacker-controlled text that reaches the model, so a flag would make "turn redaction
off" reachable from a dimension value. `src/cli/args.ts` therefore rejects every
spelling of them as a flag. Declaring all eight is also a publishing requirement rather
than a tidiness one: ClawHub's security review compares declared metadata against
actual behaviour, and `src/config.ts` reads all four, so omitting them would be an
undeclared read. A test asserts the declared set, the set the code reads, and this list
are the same eight names.

The description is 282 characters, inside the roughly 300-character budget that
keeps `openclaw skills list` rendering it in one or two table lines rather than
eight. Breadth of trigger phrasing belongs in the decision table inside
`SKILL.md`, which the agent reads after it has already chosen the skill; the
description's only job is getting it chosen. A test enforces the length.

### D7. `requires.env` is empty

The unconditional gate takes nothing. Credentials resolve from four sources, in
this order, first match wins:

1. `GA4_CREDENTIALS`, holding the service-account JSON key's contents.
2. `GA4_CREDENTIALS`, holding a path to that key file instead. The two are told
   apart by whether the trimmed value starts with `{`, per D8.
3. `GOOGLE_APPLICATION_CREDENTIALS`, the Google-standard variable.
4. gcloud application-default credentials at the well-known path.

An earlier draft of this list had "the `credentials` value in the skill's own
config entry" as source 2. There is no such entry: `src/auth/credentials.ts`
reads the environment and the filesystem and nothing else, which is what makes
`envVars` above the complete declaration of what this skill reads.

Listing any single one of those in `requires.env` would report "needs setup"
forever for every user relying on the other three, and a skill reporting "needs
setup" is invisible to the model. `requires: {bins: [node]}` is the only true
universal requirement.

The consequence is accepted deliberately: the skill reports ready before it is
configured, and the first call fails. That failure is good, because the error
taxonomy already names the fix, and `doctor` exists to be run first. A
permanently-unready skill has no equivalent recovery.

### D8. `primaryEnv: GA4_CREDENTIALS`, accepting contents or a path

Declaring `primaryEnv` is what produces the Control UI's "Save key" field and
the documented CLI key-saving route. It is the difference between a user typing
into a labelled box and a user editing JSON.

The variable accepts **either** form, discriminated by whether the trimmed value
starts with `{`:

| Value looks like | Treated as |
| --- | --- |
| `{"type":"service_account",...}` | The key's contents |
| `/home/me/key.json` or `~/key.json` | A path to the key file |

This matters for the target user. They have just clicked "download key" in the
Google Cloud console and have a file in `~/Downloads`. Asking them to move it,
`chmod 600` it, and then type its path correctly is three chances to fail.
Pasting the contents into a box is one.

**Documented cost, stated in `SKILL.md` and `PRIVACY.md` rather than buried.**
Pasting the contents puts a private key inside `~/.openclaw/openclaw.json`, and
`openclaw config set` writes a `.bak` beside that file on every change, so the
key comes to rest in two places rather than one. The path form remains available
and is the better choice for anyone who cares about that; the documentation says
so plainly instead of recommending the convenient option in silence.

### D9. `doctor --json` reports one blocking step at a time

The existing `ga4_diagnose` tool already runs the right checks in dependency
order: credentials, then Admin API and property access, then property selection,
then a live Data API report, then privacy settings. It renders them as a
markdown checklist for a human.

The skill adds `--json`, which answers a narrower and more useful question:
**what is the single next thing this person must do?** One blocking step, never
a wall of failures, because a non-technical user handed five simultaneous
problems does nothing.

```json
{
  "ok": false,
  "blocked_on": "no_property_grant",
  "principal": "ga4-reader@my-project.iam.gserviceaccount.com",
  "next": {
    "where": "Google Analytics",
    "action": "Admin > Property access management > + > Add users",
    "paste": "ga4-reader@my-project.iam.gserviceaccount.com",
    "role": "Viewer"
  },
  "url": "https://analytics.google.com/analytics/web/#/a/admin/access"
}
```

`blocked_on` values map onto the error taxonomy that already exists in
`src/ga4/errors.ts`, so the state machine is a projection of tested code rather
than a parallel invention:

| `blocked_on` | Existing code | What the user does |
| --- | --- | --- |
| `no_credentials` | `NO_CREDENTIALS`, `CREDENTIALS_MISSING` | Create a service account, download the key, save it |
| `bad_credentials` | `CREDENTIALS_REJECTED` | Re-download the key; the saved one is malformed or revoked |
| `clock_skew` | `CLOCK_SKEW` | Turn on network time sync |
| `data_api_disabled` | `DATA_API_DISABLED` | Click Enable at the printed console link |
| `admin_api_disabled` | `ADMIN_API_DISABLED` | Optional; only affects listing properties by name |
| `no_property_grant` | `NO_PROPERTY_ACCESS` | Paste the service-account address into Analytics with Viewer |
| `no_property_selected` | `NO_PROPERTY` | Choose from the properties the credential can read |
| `wrong_property` | `PROPERTY_NOT_FOUND` | The value is a `G-XXXXXXX` measurement id, not a numeric property id |
| `quota` | `QUOTA_EXHAUSTED` | Wait; nothing is broken |
| `ok` | none | Nothing; setup is complete |

Two details the code review turned up, recorded so they are handled rather than
rediscovered:

- **`NO_CREDENTIALS` and `CREDENTIALS_MISSING` are two codes for one condition**,
  raised from `src/runtime.ts` and `src/ga4/errors.ts` respectively. They
  collapse to a single code in this work, and a test asserts only one survives.
  Two codes for one state is exactly how a state machine acquires an unreachable
  branch.
- **`NO_DATA_IN_DATE_RANGE` is not a setup failure.** It maps to exit code 0 and
  the sentence "no data for that period", never to `blocked_on`. An empty result
  is a successful measurement of nothing.

`SKILL.md` carries a decision tree keyed on `blocked_on`, so the agent says
"open this link, paste this address, choose Viewer, tell me when you are done",
re-runs `doctor --json`, and advances. The user never opens a terminal and never
reads a setup document.

### D10. Command surface

Seven commands. Six are the existing tools; `properties` is separated out
because setup needs property discovery on its own, before a report is possible.

| Command | Replaces | Notes |
| --- | --- | --- |
| `doctor [--json]` | `ga4_diagnose` | Human checklist by default, state machine with `--json` |
| `report <preset>` | `ga4_report` | 18 presets |
| `compare <preset>` | `ga4_compare` | Two periods, with the change |
| `live` | `ga4_realtime` | Active users in roughly the last 30 minutes |
| `query` | `ga4_query` | Explicit dimensions, metrics, filters, sort |
| `fields <search>` | `ga4_fields` | Searches the property's live catalog |
| `properties` | folded into `ga4_diagnose` | Lists what this credential can read |

Preset ids are snake_case in the source (`top_pages`, `traffic_sources`,
`new_vs_returning`, and so on). The CLI accepts hyphens as equivalent, so
`report top-pages` and `report top_pages` both work; a model asked to produce a
command line writes hyphens more often than underscores, and failing on that
would be a self-inflicted wound.

Output is a markdown table by default. `--json` is documented as the option to
use only when a figure must be **computed**, never when a table is merely being
relayed, so the agent quotes rather than re-typesets.

### D11. Exit codes, and what each should make the agent say

| Code | Meaning | What `SKILL.md` tells the agent to say |
| --- | --- | --- |
| 0 | Worked | The answer. **Zero rows exits 0** and is reported as "no data for that period", never as a failure. |
| 2 | Bad input | Name the offending value and the accepted range. Do not retry with a guess. |
| 3 | Setup incomplete | Enter the setup tree. Never report this as "your analytics is broken". |
| 4 | Google refused | Surface Google's own machine-readable reason plus the mapped fix. |
| 1 | Unexpected | Say plainly that it failed. Never state a number that was not measured. |

Code 3 exists to be distinguishable from code 4: "you have not finished setting
this up" and "Google said no" call for completely different conversations, and
collapsing them is how a setup problem gets reported as an outage.

### D12. Licence changes to MIT-0

ClawHub relicenses everything it hosts to MIT-0. Shipping MIT while the
distribution channel serves MIT-0 means the licence a user receives is not the
licence in the repository. Changing the repository to MIT-0 removes that
mismatch. MIT-0 drops the attribution requirement, which is a deliberate
giveaway, approved on 2026-08-16.

## What `SKILL.md` contains, in order

Written for an agent making a decision, not for a human reading top to bottom:

1. **Phrasing-to-command decision table.** What the user might say, in their
   words, several variants per row, against the exact command. Highest-value
   content in the file.
2. **The setup tree**, keyed on `blocked_on`.
3. **What to do when input is vague.** "The blog" with three properties
   configured means list them and ask. A confident answer about the wrong
   property is the worst available outcome.
4. **When to use `--json`.** Only to compute, never to relay.
5. **Exit codes**, and the sentence each should produce.
6. **"Never state a number that was not measured."** Written explicitly.
7. **Analytics values are untrusted input.** Dimension values are authored by
   site visitors, so they are a prompt-injection channel; the fenced data block
   is what separates them from trusted output.
8. Reference material: presets, flags, filters, date ranges, gotchas.

## Tests

The 277 existing tests carry over unchanged apart from the removal of
`src/index.test.ts`, which tests the deleted plugin entry. Added:

- **Docs pinned to code.** Every command quoted in `SKILL.md` and `README.md`
  parses and runs under `--dry-run`.
- **Frontmatter pinned to code.** Every environment variable the code reads is
  declared in the frontmatter, and every declared variable is read by the code.
  An undeclared variable that the code reads is a publishing problem, not just a
  documentation one: ClawHub's security review compares declared metadata
  against actual behaviour.
- **Identity.** Frontmatter `name`, the ClawHub slug and the repository name are
  the same string; frontmatter `version` equals `package.json` version.
- **Description length** stays under 300 characters, so `openclaw skills list`
  renders it in one or two lines rather than eight.
- **Reproducible build.** A fresh compile of `src/` is byte-identical to the
  committed `lib/`.
- **Every `blocked_on` value** in the `SKILL.md` setup tree exists in the code,
  and every value the code can emit appears in the tree.
- **Example output is generated**, by driving the real entry point through a
  fake transport and capturing stdout, never hand-written.
- **Mutation checks.** For each new test, break the code deliberately and
  confirm something fails. A mutation that survives means the test is
  decoration.

## Release

CI gains the reproducible-build check on every pull request.

A release workflow fires on a published GitHub release and runs:

```
clawhub skill publish /absolute/path/to/checkout \
  --slug open-ga4 --name "Open GA4" --version X.Y.Z --tags latest \
  --source-repo anatoli-iliev/open-ga4 --source-ref vX.Y.Z --source-commit <sha> \
  --changelog "..."
```

An absolute path, never `.`: `clawhub` resolves a relative folder argument
against its own workdir, which falls back to the OpenClaw workspace when the
current directory has no `.clawhub/` marker, so `publish .` publishes the wrong
directory and reports `SKILL.md required` about a directory nobody named.

`--source-repo`, `--source-ref` and `--source-commit` tie the listing to an
exact commit, which lets a reader diff what is published against what is on
GitHub. For anything that asks a user for a credential, that is worth doing.

Publishing is asynchronous. `clawhub skill verify open-ga4 --version X.Y.Z` is
the cheap way to read state; `clawhub scan` queues a **new** scan on every
invocation and blocks for minutes, so it must not be used to poll. A
`card.missing` reason immediately after publishing is normal: the skill card is
generated server-side on its own schedule and affects only how the page renders.
It is not a reason to act.

## Verification before this is called done

- `openclaw skills check` reports `open-ga4` ready.
- The **published** artifact is installed into a scratch workspace and driven as
  a new user would, with nothing from the development machine on hand. This is
  the check that catches dropped executable bits and absent dependencies, and it
  is the only one that tests what users receive rather than what was written.
- An agent is asked to use it in vague, non-technical words, and the setup tree
  is walked end to end from an unconfigured state.
- At least one live call against a real GA4 property for every code path that
  touches a shape the Google schema does not pin.

## Pull request sequence

Each is a feature branch, a pull request, and an admin-bypass squash merge.

| # | Branch | Contents |
| --- | --- | --- |
| 1 | `chore/codeowners` | CODEOWNERS. **Merged 2026-08-16.** |
| 2 | `docs/open-ga4-design-spec` | This document. |
| 3 | `feat/rename-open-ga4` | Rename product, package and repository; MIT-0. |
| 4 | `feat/drop-plugin-sdk` | Delete the plugin entry, typebox and the openclaw dependency. |
| 5 | `feat/cli` | The command line and its exit codes. |
| 6 | `feat/doctor-json` | `doctor --json` and the setup state machine. |
| 7 | `feat/skill-md` | `SKILL.md`, frontmatter, and the docs-pinning tests. |
| 8 | `feat/ship-lib` | Committed `lib/` and the reproducible-build check. |
| 9 | `feat/release` | Release workflow, ClawHub publish, published-artifact verification. |

## Risks

| Risk | Mitigation |
| --- | --- |
| `open-ga4` turns out to be taken at publish time | Search says otherwise; if wrong, `private-ga4` and `plain-ga4` were also clear, and `clawhub skill rename` keeps the old slug as a redirect. |
| Committed `lib/` drifts from `src/` | CI fails on any byte difference. |
| A user pastes a private key and it lands in a `.bak` | Documented explicitly; the file-path route stays available and is recommended for anyone who minds. |
| The setup tree goes stale as Google moves console pages | Every `blocked_on` value is tested against the code, and console URLs are asserted to be reachable hosts on the existing allowlist. |
| Losing `resultContentSource` weakens injection labelling | Accepted in D1; the fenced-block rendering that does the real work is unchanged and still tested. |
