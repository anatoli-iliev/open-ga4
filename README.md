# open-ga4

Read-only Google Analytics 4 reporting for an OpenClaw agent, running on your own machine.

**Open GA4** adds six tools to OpenClaw so an agent can answer questions about a GA4
property: what the top pages were last month, where traffic came from, what changed since
last year, who is on the site right now. It calls Google's REST API directly: no gateway,
no vendor account, no Python. It is for people who run OpenClaw locally, and who would
rather read a skill's whole network surface than trust a description of it. That surface
is one runtime dependency, three allowed hosts, and one OAuth scope.

## What it does

| Tool | What it returns |
| --- | --- |
| `ga4_report` | One preset report (top pages, traffic sources, channels, countries, devices, events, ecommerce and more) as a markdown table. |
| `ga4_compare` | Two named periods side by side, with the change between them. |
| `ga4_realtime` | Active users in the last 30 minutes. The only tool that sees today. |
| `ga4_fields` | Searches the property's live dimension and metric catalog and returns exact API names. |
| `ga4_query` | Full control: your own dimensions, metrics, filters and sort order. |
| `ga4_diagnose` | Runs the setup checks in dependency order, names the first failure and its fix, and lists the properties this credential can read. |

Things you can ask in plain English:

- "What were my top pages last month?"
- "How did the last 28 days compare with the 28 days before that?"
- "Which channels drove the most key events this year?"
- "Is anyone on the site right now?"

Presets carry dimension and metric names that are known to work together, so the model
names an intent instead of guessing that "pageviews" is spelled `screenPageViews` and that
"conversions" is now `keyEvents`. When no preset fits, `ga4_query` takes the fields directly.

## Install

Install instructions are rewritten in the skill packaging change; see
[the design spec](docs/superpowers/specs/2026-08-16-open-ga4-design.md).

## Setup

Five steps here, eight in the click-by-click version, about ten minutes.
[SETUP.md](SETUP.md) has it with console links.

1. **Create a Google Cloud project** and enable the Google Analytics Data API. Enable the
   Admin API too if you want `ga4_diagnose` to list your properties by name; reports work
   without it.
2. **Create a service account.** Skip the "grant this service account access to project"
   step; a Cloud IAM role does nothing for GA4 access.
3. **Download a JSON key**, move it somewhere private, and `chmod 600` it. That file is a
   password.
4. **Grant the service account read access in Google Analytics.** This is the step
   everyone gets wrong. Copy the `client_email` from the key file (it looks like
   `something@project.iam.gserviceaccount.com`), then open Google Analytics, go to
   **Admin > Property access management**, click **+ > Add users**, paste that address,
   untick "Notify new users by email", and give it **Viewer** and nothing else. Access is
   granted here, inside Analytics, not in Google Cloud. Skipping this produces a 403 that
   says nothing useful; `ga4_diagnose` translates it.
5. **Point the skill at the key and the property id**, then run `ga4_diagnose`. The
   property id is the 9–10 digit number under **Admin > Property details**, not the
   `G-XXXXXXXXXX` measurement ID from your site's tag. Paste the measurement ID and the
   skill will tell you which number you actually need.

## Why this one

- **One runtime dependency.** `typebox`, which OpenClaw already depends on and which has no
  dependencies of its own. OAuth is a signed JWT built with `node:crypto`; the API is called
  with `fetch`. No gRPC stack, no generated protos, no `google-auth-library`, no Python.
  You can read the whole client in one sitting.
- **An egress allowlist enforced in code.** Every request goes through one guard that
  rejects any host other than `oauth2.googleapis.com`, `analyticsdata.googleapis.com` and
  `analyticsadmin.googleapis.com`, before the request is made, and redirects are an error
  rather than something to follow, so a 302 cannot reach a host that was never checked. A
  test scans the built bundle for `https://` URLs and fails on any host that is neither one
  of those three nor on a short reviewed list of addresses that only ever appear as text:
  `console.cloud.google.com` and `console.developers.google.com`, which are the "enable the
  API here" link printed in an error message, and `www.googleapis.com`, which appears
  inside the OAuth scope identifier. Your credentials go to Google and to no third-party
  service. The allowlist constrains which host the skill asks for, not what your system
  does with the request: if OpenClaw or your machine is configured with an HTTP proxy or a
  TLS-intercepting middlebox, this traffic traverses it exactly as all other OpenClaw
  traffic does.
- **Read-only by scope.** The only scope requested is
  `https://www.googleapis.com/auth/analytics.readonly`, and a test asserts no other
  `googleapis.com/auth/` string exists in the shipped bundle.
- **No telemetry, and no report data on disk.** No phone-home, no update check, no usage
  counter. Tokens are held in memory only; a cached Google access token in a file is a
  credential at rest that you did not agree to.
- **Errors that name the fix.** A missing property grant becomes "add this address in
  Admin > Property access management with the Viewer role". A disabled API becomes the
  console link that enables it. A machine whose clock has drifted becomes "turn on network
  time sync" instead of `invalid_grant`. Diagnosis reads Google's machine-readable status
  and reason fields, never its error prose.
- **Reports say what they do not mean.** Sampling, Google's minimum-aggregation
  thresholding, `(other)`-row rollups, restricted metrics and the property's own time zone
  each produce one plain sentence, and only when the flag is actually set.

Verified comparisons, each backed by a fetched artifact:

| Project | Verified fact | Here instead |
| --- | --- | --- |
| [`adamkristopher/ga4-api-toolkit`](https://github.com/adamkristopher/ga4-api-toolkit) | `src/api/reports.ts` `runReport()` accepts `filters` and `orderBy`, then never uses them when building the request; a filtered question returns whole-site numbers with no error. It also defaults `save=true`, writing results to disk. | A parameter this skill cannot honour raises an error naming why, rather than being dropped: asking `overview` for a filter says that report has no dimension to filter on. Ranked presets carry an explicit sort; single-row summaries do not, because sorting one row means nothing. Nothing writes report data to disk. |
| [`jdrhyne/agent-skills`](https://github.com/jdrhyne/agent-skills) GA4 skill | `skills/ga4/SKILL.md` declares `requires: {"bins": ["python3"]}` and every example runs `python3 scripts/ga4_query.py`. Those scripts tell you to `pip install google-analytics-data google-auth-oauthlib` on the host. | A TypeScript plugin that runs in the OpenClaw process. No Python, no `pip`, no shell tool. |

## Analytics data is untrusted input

GA4 dimension values are not written by you. They are written by whoever visited your site.
Anyone can open `yoursite.com/?<any text they like>` and that text lands in `pagePath` and
`pagePathPlusQueryString` in tomorrow's report. The same goes for `pageTitle`,
`pageReferrer`, `landingPage`, `sessionCampaignName` and every other visitor-derived or
marketer-written field. Referrer spam has been doing this to Google Analytics for a decade
for SEO reasons. An agent that reads those values turns it into a prompt-injection channel.

This skill does two things about it:

1. Every tool registers with `resultContentSource: "network"`, OpenClaw's marker for
   externally controlled content. The field landed in OpenClaw 2026.8; the newest released
   host today is 2026.7.1-2, which does not read it, so there the field is emitted and
   ignored. It is set unconditionally so the labelling takes effect when you upgrade. Until
   then the framing below is what separates visitor-authored text from trusted output.
2. Report rows are rendered inside a fenced block introduced as data supplied by site
   visitors, rather than interpolated into prose. Every table cell of every tool has `|`
   escaped and newlines collapsed, so a value cannot forge table structure or start a line
   of its own. `ga4_fields` and `ga4_diagnose` list field, property and account names in a
   plain table without that fence.

This reduces risk. It does not eliminate prompt injection, and nothing does. If you wire an
agent to act on GA4 data (send email, file tickets, change bids), keep a human in that
loop. The numbers are trustworthy. The strings are not.

## Privacy

Full detail in [PRIVACY.md](PRIVACY.md). The short version:

- Every dimension value in a report passes through redaction before the model sees it,
  unless you set `privacy.redact` to `false`: emails, phone numbers, UUIDs, JWTs, card
  numbers confirmed by Luhn, long opaque tokens, and the values of query parameters outside
  a keep-list. The report says how many values were masked.
- `userId` and user-scoped custom dimensions are refused unless you explicitly opt in.
- The skill never calls `properties.audienceExports`, `properties.audienceLists` or the
  Admin API's `runAccessReport`, the three surfaces built to hand back rows keyed to an
  individual visitor, and a test asserts those strings are absent from the built bundle.
  That is narrower than "cannot read per-user data": `runReport` returns per-person rows as
  soon as the `userId` dimension is used, which is why that dimension is blocked by default.
- **What this does not protect you from:** report data returned to the agent is seen by
  whatever model provider you have configured. This skill controls what it asks Google for
  and what it hands to the agent. Redaction runs here, on a response that has already left
  Google and arrived on your machine in full, so it changes what the model sees and not what
  Google holds. It has no say in what your own LLM provider does with a report once the
  agent reads it. Choose the property, the date range and the provider accordingly.

## Development

```bash
npm install
npm run check         # typecheck, then tests, then build
npm test              # vitest, no network, no credentials
npm run typecheck
```

`npm test` builds first, because `src/privacy/surface.test.ts` asserts the privacy
guarantees against `dist/` (the bundle that actually ships) rather than against the
source. `src/docs.test.ts` checks this file: every configuration example here is validated
against the real config schema, and every `ga4_` tool name, npm script and Google host
mentioned in the documentation must exist.

`openclaw plugins build` and `openclaw plugins validate` understand only `defineToolPlugin`
entries and reject this one, so `openclaw.plugin.json` is maintained by hand and
`src/index.test.ts` asserts it matches what the code registers.

If you do run the OpenClaw CLI against this repo, use `scripts/openclaw-sandbox.sh`.
`openclaw plugins build|validate` boots enough of the runtime to run config doctor and
state migrations; against a real installation that can rewrite your config and relocate
your state files. Setting `OPENCLAW_STATE_DIR` alone is not enough, because migrations
still probe the legacy paths under `$HOME`. The wrapper redirects `HOME`, the XDG
config/state/data directories and the OpenClaw config and state directories into a
throwaway `.sandbox/`, so nothing can touch your own OpenClaw setup.

The design decisions, and what was rejected, are in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT-0 (MIT No Attribution) © 2026 Anatoli Iliev <anatoli@helphabit.com>. See
[LICENSE](LICENSE).

## Trademarks

This is an independent open-source project. It is not affiliated with, endorsed by, or
sponsored by Google LLC. Google Analytics and GA4 are trademarks of Google LLC.
