# Design: `open-ga4`

Status: accepted · 2026-08-14

## Problem

An OpenClaw agent cannot answer "how did the site do last week?" without a
Google Analytics integration. The integrations that exist today each solve a
slice of the problem and impose real setup cost:

- **Python-shelling skills** ship a `SKILL.md` plus a `scripts/*.py` file and
  require `uv`, a virtualenv, and the `google-analytics-data` package (tens of
  megabytes, hundreds of transitive dependencies) before the first question can
  be asked. They typically expose exactly one hardcoded report.
- **Hosted MCP connectors** solve setup by routing analytics data through a
  third-party server. That is a privacy and trust cost the user cannot audit.
- **Thin API wrappers** expose `runReport` verbatim and leave the model to guess
  GA4's ~200 dimension and ~150 metric API names, which it gets wrong.

## Goals

1. Working answer in under five minutes, for someone who is not a developer.
2. The model picks correct dimensions and metrics on the first attempt.
3. Every privacy claim is enforced by code and covered by a test.
4. The dependency and network surface is small enough to audit in one sitting.

## Non-goals

- Writing to Google Analytics. The plugin is read-only by construction.
- Replacing the GA4 UI. Deep, exploratory analysis stays in the console.
- Supporting Universal Analytics (shut down; the API is gone).

## Decisions

### D1. Package shape: `definePluginEntry`

`defineToolPlugin` is the obvious choice for a tools-only plugin and was the
first pick. It is wrong here. Reading the real SDK source rather than the docs
(`src/plugin-sdk/tool-plugin.ts`), the object it hands to `api.registerTool` is
exactly `{ name, label, description, parameters, outputSchema?, execute }`:
there is no way to set `resultContentSource`, and no `register(api)` callback,
so `registerHealthCheck` is unreachable. Both are load-bearing here (see D6).

So: `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`, with a
hand-maintained `openclaw.plugin.json`. The cost is that `contracts.tools` must
be kept in step with the code by hand; a test asserts the manifest matches the
registered tool names so drift fails CI rather than silently hiding a tool.

Ships built JavaScript (`./dist/index.js`) via `openclaw.extensions`, per the
packaging rule that source entries only work for workspace-local development.
`compat.pluginApi` targets the newest *released* host, not the repository's
`main` version; copying the bundled extensions' `>=2026.8.1` would make the
plugin uninstallable on every host that actually exists today.

### D2. Zero network dependencies

Runtime dependencies: **`typebox` only**, which OpenClaw itself depends on and
which has no dependencies of its own. Everything else is Node built-ins.

Rejected: `@google-analytics/data` (gRPC stack and generated protos),
`googleapis` (very large), `google-auth-library` (pulls `gaxios`, `gcp-metadata`,
and an HTTP stack we would then have to constrain).

Consequence: the plugin implements OAuth service-account JWT assertion itself
with `node:crypto` (`createSign("RSA-SHA256")`) and calls the GA4 REST API with
the host's configured `fetch`. This is roughly 150 lines and it makes the egress
claim below verifiable by reading one file.

### D3. Auth: service account by default, ADC as fallback

Resolution order, first match wins:

1. `plugins.entries.ga4.config.credentials`: a path to a service-account JSON
   key, or an OpenClaw `SecretRef`.
2. `GOOGLE_APPLICATION_CREDENTIALS`: the Google-standard environment variable.
   Chosen because existing GA4 skills already set it, so users migrating keep
   their setup.
3. Application Default Credentials at the well-known gcloud path
   (`~/.config/gcloud/application_default_credentials.json`), which is an
   authorized-user refresh-token grant rather than a service account.

Rejected as the default: an interactive OAuth loopback flow. It requires the
user to create their own OAuth client and consent screen in Google Cloud, and
unverified "Testing" apps have refresh tokens that expire after seven days;
the integration would silently break weekly.

Only ever requests `https://www.googleapis.com/auth/analytics.readonly`.

### D4. Tool surface: intent-shaped, with one escape hatch

Six tools. Wide enough to cover what people ask, narrow enough that the model
picks correctly:

| Tool | Purpose |
| --- | --- |
| `ga4_diagnose` | Check every setup requirement, print the exact fix for the first failure, and list the properties the credential can read. |
| `ga4_fields` | Search the property's live dimension and metric catalog by keyword. |
| `ga4_report` | The workhorse: one enum picks a ready-made report. |
| `ga4_compare` | The same reports across two consecutive periods. |
| `ga4_realtime` | Active users in roughly the last 30 minutes. |
| `ga4_query` | The escape hatch: explicit dimensions, metrics, filters and sort. |

`ga4_report` takes a single `report` enum that expands to a verified
dimension/metric combination, so naming an intent is enough and there is
nothing to guess. Anything the presets do not cover goes to `ga4_query`.

Splitting those two rather than putting a `preset` parameter alongside optional
`dimensions` and `metrics` on one tool keeps the common tool's schema to one
enum, which is the whole point: a model that only has to pick an enum value
cannot pick an incompatible dimension/metric pair.

A separate `ga4_properties` was in the first draft and was folded into
`ga4_diagnose`. Property discovery is nearly always something you do because
setup is not working yet, and every tool schema is spent from the context
window of every conversation whether it is used or not.

Results render as markdown tables, not raw JSON: fewer tokens, and the model
reads them more reliably.

### D5. Privacy controls, enforced in code

| Control | Default | Enforcement |
| --- | --- | --- |
| Read-only scope | always | Scope constant; no write endpoint exists in the client. |
| Egress allowlist | always | Every request passes a host check; unknown hosts throw. |
| PII redaction of dimension values | on | Query strings, emails, phone numbers, UUIDs, and long digit runs are masked before the model sees them. |
| User-identifying dimensions blocked | on | `userId` and user-scoped custom dimensions require explicit opt-in. |
| Property allowlist | off | When set, requests to other properties are refused. |
| Report data persisted to disk | never | No cache file, no report log. |
| Credentials in output or logs | never | Redaction covers errors, logs, and tool results. |
| Telemetry | none | No analytics, no phone-home, no update check. |
| Local audit log | off | Opt-in; records query, property, and timestamp, never response bodies. |

The honest limitation, stated in `PRIVACY.md` rather than buried: report data
returned to the agent is seen by whatever model provider the user has
configured. The plugin controls what leaves Google, not what the user's own LLM
does with it.

### D6. Analytics data is attacker-controlled input

This is the part most GA4 integrations miss. A dimension value like `pagePath`
or `pageTitle` is not authored by the property owner; it is whatever a visitor
requested. Anyone on the internet can visit
`yoursite.com/?ignore-previous-instructions-and…` and have that string appear in
tomorrow's report, and from there in an agent's context as though it were data
the owner wrote.

Two consequences:

1. Every tool registers with `resultContentSource: "network"`, which is
   OpenClaw's marker for externally controlled content. This is the concrete
   reason D1 could not use `defineToolPlugin`.
2. Report rows are rendered into a fenced, clearly labelled data block rather
   than interpolated into prose, so injected text does not read as instruction.

Neither is a complete defence against prompt injection (nothing is), but
declaring the provenance is strictly better than the current practice of
returning `JSON.stringify(response)` and hoping.

### D7. No hardcoded field catalog as the source of truth

GA4 renames things: `conversions` became `keyEvents`, and the old names survive
only in `MetricMetadata.deprecatedApiNames`. Two of the research briefs produced
hand-maintained field lists that disagreed with each other, which is the whole
argument against shipping one as truth.

The live `properties/{id}/metadata` response is authoritative and is what
`ga4_fields` searches. A generated snapshot ships for offline preset validation
and fast startup, and a CI script re-fetches metadata to fail the build if any
shipped name has disappeared. Diagnostics for a bad field name come from that
metadata and from `checkCompatibility`, never from string-matching Google's
error prose, which is unversioned and undocumented.

### D8. Errors map to fixes, not stack traces

Every known GA4 failure maps to a sentence naming the cause and a next action:
API not enabled, service account missing property access, wrong property ID,
measurement ID (`G-XXXXXXX`) used where a numeric property ID is required,
invalid dimension or metric name (with the closest valid names suggested),
incompatible dimension/metric pairing, and quota exhaustion.

`ga4_diagnose` runs the same checks proactively so a user can fix setup without
first triggering a failure.

## Architecture

```
index.ts                 defineToolPlugin entry; wires config → tools
src/config.ts            typebox config schema + resolution
src/auth/                credential discovery, RS256 JWT, token cache
src/ga4/                 egress-guarded fetch, Data API, Admin API,
                         error taxonomy, dimension/metric catalog,
                         date parsing, markdown formatting
src/privacy/             redaction, dimension policy, property allowlist,
                         optional audit log
src/tools/               one file per tool
```

Each module is independently testable: auth does not import the HTTP client,
redaction does not import the API layer, tools compose the rest.

## Verification

- `npm test`: unit tests per module, with recorded GA4 responses as fixtures.
- `npm run plugin:validate`: OpenClaw's own manifest and entry validation.
- A live read-only smoke test against a real property, run manually, never in
  CI (CI has no credentials and must not need any).
