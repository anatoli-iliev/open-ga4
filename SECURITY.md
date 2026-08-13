# Security Policy

`openclaw-plugin-ga4` runs on your machine, holds a Google credential, and returns data
that strangers on the internet can write into. This document says what it defends
against, how the defence is enforced, and where it stops.

## Supported versions

| Version | Supported | Notes |
| --- | --- | --- |
| 0.1.x | Yes | Current line. Security fixes ship as a patch release. |
| < 0.1.0 | — | No earlier releases exist. |

Fixes land on the newest patch of a supported line. There are no backports to older
patches — upgrade instead.

## Reporting a vulnerability

Use either channel. Both reach the same person.

- **Email** anatoli@helphabit.com, with `openclaw-plugin-ga4` in the subject.
- **GitHub private security advisory** —
  <https://github.com/anatoli-iliev/openclaw-plugin-ga4/security/advisories/new>

Please do not open a public issue, discussion, or pull request for a vulnerability.

| Stage | Target |
| --- | --- |
| Acknowledgement | 72 hours |
| Severity assessment and a fix plan | 7 days |
| Fix released | 30 days from the report |
| Public advisory | Published with the fix, or later by agreement |

Disclosure is coordinated. The advisory goes out when the fix is available, or sooner
if the issue is already public. If you need more than 30 days for your own reasons,
say so and we will agree a date. You will be credited in the advisory unless you ask
not to be.

Useful in a report: the plugin version, the OpenClaw version, Node version, what you
did, what happened, and what you expected. A failing test is the fastest possible
report.

**Do not paste a service-account key, an access token, or a live GA4 report into your
report.** A redacted excerpt is enough, and the key is a password.

Bug bounty: there is no bounty programme. This is an unfunded open-source project.

## Threat model

Six threats, in the order they are worth worrying about. Each says what the plugin
does and what it does not do.

### 1. Credential theft from the key file on disk

**The risk.** The Google service-account JSON key is a password in a file. Anyone who
reads it can read every GA4 property that key has been granted, from anywhere, until
the key is revoked. The same is true of the `authorized_user` file that
`gcloud auth application-default login` writes.

**What the plugin does.**

- Reads the credential from the path you configured and nothing else. Nothing is
  copied, rewritten, or normalised back onto disk (`src/auth/credentials.ts`).
- Never writes key material to a log, an error, or a tool result. `redactText`
  (`src/privacy/redact.ts`) strips PEM `PRIVATE KEY` blocks, `Bearer` tokens, and the
  JSON fields `access_token`, `refresh_token`, `id_token`, `private_key`,
  `client_secret`, `api_key` and `apiKey`. It runs unconditionally in `guardedFetch`
  (`src/ga4/http.ts`) and in the error mapper (`src/ga4/errors.ts`). There is no
  config switch, because there is no legitimate reason to surface a key.
- `ga4_diagnose` reports where a credential was found and whether it parsed — a label,
  a path, and a status. It never prints the contents.
- The private key never leaves the process. `node:crypto` `createSign("RSA-SHA256")`
  signs the OAuth assertion locally; the signature goes to Google, the key does not.
- Access tokens live in a variable for their one-hour lifetime and die with the
  process. No token file. A cached Google token on disk is a credential at rest that
  you never agreed to.

**Your part.** `chmod 600` the key file. Keep it out of the repository, out of any
synced or backed-up folder, and out of your shell history. Delete the key in Google
Cloud when you stop using it — revocation is instant and free.

**What it does not do.** File permissions are the operating system's job. Anything
running as your user can read your key, with or without this plugin.

### 2. Prompt injection through GA4 dimension values

**The risk.** GA4 dimension values are not written by you. They are written by whoever
visited your site. Anyone can open `yoursite.com/?<any text they like>` and that text
appears in `pagePath` and `pagePathPlusQueryString` in tomorrow's report. The same
holds for `pageTitle`, `pageReferrer`, `landingPage`, `searchTerm`,
`sessionCampaignName` and every other visitor-derived or marketer-written field.
Referrer spam has been pushing strings into Google Analytics for a decade for SEO
reasons. An agent that reads those values turns that into a prompt-injection channel.

**What the plugin does.**

- Every tool registers with `resultContentSource: "network"` — OpenClaw's marker for
  externally controlled content — so results are labelled untrusted rather than
  treated as trusted tool output. This constraint is why the plugin uses
  `definePluginEntry` rather than `defineToolPlugin`, which cannot set the field.
- Rows are rendered inside a fenced block introduced as data supplied by site
  visitors, not interpolated into prose. Values have `|` escaped, newlines collapsed
  and control characters stripped, so a value cannot forge table structure or start a
  line of its own.
- The header and caveat lines are generated by the plugin from Google's
  `ResponseMetaData`, never from row content, so injected text cannot impersonate a
  date range or a warning.
- Redaction runs on every value of every row before the model sees it
  (`src/privacy/redact.ts`).

**What it does not do.** None of this stops a model from acting on text it read. It
reduces the risk; it does not eliminate it, and nothing does. If you wire an agent to
act on GA4 data — send email, file tickets, change bids — keep a human in that loop.
The numbers are trustworthy. The strings are not.

**In scope for a report:** a dimension value that escapes the fenced block, forges a
header or caveat line, or otherwise breaks the framing. That is a bug in this plugin.
**Out of scope:** a model choosing to follow instructions that were correctly labelled
as untrusted network content.

### 3. Exfiltration through a compromised dependency

**The risk.** The usual way to talk to GA4 is `@google-analytics/data` or
`googleapis`, which bring a gRPC stack, generated protos, and hundreds of transitive
packages. Any one of them can ship a postinstall script or a patched HTTP call, and
the credential is right there.

**What the plugin does.**

- **One runtime dependency:** `typebox`, which OpenClaw itself depends on and which
  has no dependencies of its own. `npm ls --omit=dev --all` prints `typebox` and
  nothing else. OAuth is a signed JWT built on `node:crypto`; the GA4 REST API is
  called with `fetch`. No gRPC, no generated SDK, no `google-auth-library`, no Python.
- The egress allowlist (below) means plugin code has one route to the network and it
  is guarded.
- CI has no credentials and needs none, so a compromised devDependency running in a
  pull-request build has nothing to steal. Workflow permissions are `contents: read`.

**What it does not do.** The allowlist is not a sandbox. It constrains code that goes
through `guardedFetch`; a malicious package inside your Node process can call `fetch`
or `net` directly, and no library-level check can stop it. The real mitigation here is
that there is almost nothing to compromise: one dependency, and an audit of the whole
network path is a morning's reading.

### 4. SSRF and egress to an attacker-controlled host

**The risk.** A URL that reaches an HTTP client from data — a property id, a field
name, a `help.links[].url` inside a Google error payload — is a route out of the
machine, carrying a bearer token in the header.

**What the plugin does.** `assertAllowedUrl` in `src/ga4/http.ts` runs before every
request, and `guardedFetch` is the only way out. The check is exact-match on
`URL.host`, and only `https:` passes:

| Host | Why |
| --- | --- |
| `oauth2.googleapis.com` | Exchange a credential for a one-hour access token |
| `analyticsdata.googleapis.com` | `runReport`, `runRealtimeReport`, `metadata`, `checkCompatibility` |
| `analyticsadmin.googleapis.com` | `accountSummaries` — the property list `ga4_diagnose` prints |

Nothing else, ever. Adding a host is a visible, reviewable diff in one constant.

`src/ga4/http.test.ts` covers the bypasses that matter:

| Blocked | Example |
| --- | --- |
| Unrelated host | `https://evil.example.com/steal` |
| Lookalike suffix | `https://analyticsdata.googleapis.com.evil.example.com/x` |
| Lookalike prefix | `https://notanalyticsdata.googleapis.com/x` |
| A different Google API | `https://gmail.googleapis.com/v1/messages` |
| Userinfo smuggling the real host | `https://analyticsdata.googleapis.com@evil.example.com/x` |
| Non-default port on an allowed host | `https://analyticsdata.googleapis.com:8443/x` |
| Plain HTTP | `http://analyticsdata.googleapis.com/v1beta/x` |
| Non-HTTPS scheme | `file:///etc/passwd` |
| Unparseable input | `not-a-url` |

One test asserts the refusal happens **before** `fetch` is called at all, not after.
Separately, `src/privacy/surface.test.ts` scans every `.js` file in `dist/` for
`https://` hosts and fails on any host that is neither contacted nor an explicitly
listed console link shown to a human.

**What it does not do.** The plugin uses the `fetch` it is given. If OpenClaw is
configured with an HTTP proxy, or your machine has a TLS-intercepting middlebox, this
traffic traverses it exactly as all other OpenClaw traffic does. The allowlist
constrains which host the plugin asks for — not what your OS and your OpenClaw
configuration then do with the request.

### 5. Over-broad Google permissions

**The risk.** A credential granted more than reporting needs. Write scope, account-level
access instead of property-level, or a Cloud IAM role nobody understands.

**What the plugin does.**

- Requests exactly one OAuth scope:
  `https://www.googleapis.com/auth/analytics.readonly`. A test asserts the set of
  `https://www.googleapis.com/auth/...` strings in the shipped bundle is exactly that
  one. Google enforces scope server-side regardless of what a client asks for.
- The complete Google surface is five read methods in one hand-written file
  (`src/ga4/client.ts`): `runReport`, `runRealtimeReport`, `getMetadata`,
  `checkCompatibility`, `listAccountSummaries`. There is no generated SDK in which an
  update could quietly introduce `deleteProperty`.
- **It never calls `properties.audienceExports`, `properties.audienceLists`, or
  `runAccessReport`** — the only Data and Admin API surfaces that return rows about
  identified individuals rather than aggregates. `src/privacy/surface.test.ts` walks
  every `.js` file in `dist/` and asserts those strings are absent from the built
  bundle. That test is the whole claim, and it is deliberately narrower than "it
  cannot read per-user data", which would be an overclaim.
- `userId`, `signedInWithUserId` and user-scoped custom dimensions are refused by
  default (`src/privacy/policy.ts`). Turning them on is an explicit config key.
- An optional `privacy.propertyAllowlist` refuses any property id you did not list.
- Setup grants **Viewer on one property**, inside Google Analytics under
  Admin > Property access management. No Cloud IAM role is needed and none helps.

**What it does not do.** Scope is a ceiling, not a floor. If you grant the service
account access to your whole Analytics account, the read-only scope still prevents
writes — but everything in that account becomes readable. Grant Viewer, on the
properties you actually want read, and nothing more.

### 6. Supply-chain tampering of the published package

**The risk.** Someone publishes a build to npm that was not built from this source, or
a moved Git tag silently changes what the release pipeline runs.

**What the plugin does.**

- **Pinned CI.** Every GitHub Action in `.github/workflows/ci.yml` is pinned to a full
  commit SHA with the version in a trailing comment. A tag can be moved; a SHA cannot.
  Dependabot proposes updates weekly (`.github/dependabot.yml`) so pinning does not
  mean rotting.
- **Least privilege in CI.** `permissions: contents: read` at workflow level. No
  secrets are used, because tests need no credentials and no network.
- **Provenance on release.** Releases are published from GitHub Actions with
  `npm publish --provenance`, using the workflow's OIDC identity. npm then records the
  repository, workflow and commit that produced the tarball, and you can verify it
  with `npm audit signatures` or from the Provenance panel on the npm page. Any build
  claiming to be this package without a provenance attestation pointing at
  `anatoli-iliev/openclaw-plugin-ga4` did not come from here.
- **A small tarball.** `files` in `package.json` limits the published package to
  `dist`, `openclaw.plugin.json` and `README.md`. No key files, no `.env`, no
  `.sandbox`.

**Current state, stated plainly.** No release has been published to npm yet, and this
repository intentionally contains **no publish workflow** — a publish job that can be
triggered by a push is a foot-gun. When one lands it will be gated on a `release`
event, and it is not armed until an `NPM_TOKEN` is deliberately configured.

## What is out of scope

These are real considerations. They are not vulnerabilities in this plugin, and
reports about them will be closed with a pointer back here.

- **Your own LLM provider seeing report data.** A returned report enters the agent's
  context and is sent to whatever model provider you configured OpenClaw to use, under
  that provider's terms. Returning data to the model *is* the feature. This plugin
  controls what leaves Google and what reaches your machine; it has no say in what
  your provider does with a report afterwards. Redaction reduces what is in those
  rows. It does not keep them off the wire. If your threat model excludes your model
  provider, no plugin can change that calculus — choose the property, the date range
  and the provider accordingly.
- **Google's own data handling.** What Google collects, retains, samples, thresholds
  or infers about your visitors is between you and Google, and is unchanged by
  installing this. Read Google's own documentation and terms rather than a
  paraphrase here.
- **Anything requiring local access you already have.** Editing the OpenClaw config to
  set `privacy.redact` to `false`, enabling `allowUserIdentifyingDimensions`, reading
  the key file, or patching `dist/`. These are safe defaults, not access controls. An
  attacker already executing code as your user can read the credential directly; the
  plugin is not the weakest link in that scenario.
- **Findings that require a modified build.** Reports must reproduce against a clean
  checkout or a published release.
- **Aggregate data identifying a person.** "One session, from Reykjavík, on an iPhone,
  that hit `/careers/apply`" is not anonymous in a small enough cohort. Every
  individual field is innocuous and no pattern can fix it. This is a property of
  analytics, not a defect here.

---

This is an independent open-source project. It is not affiliated with, endorsed by, or
sponsored by Google. Google Analytics and GA4 are trademarks of Google LLC.

MIT licensed. Copyright 2026 Anatoli Iliev <anatoli@helphabit.com>.
