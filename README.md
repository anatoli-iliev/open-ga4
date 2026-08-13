# openclaw-plugin-ga4

Read-only Google Analytics 4 reporting for an OpenClaw agent, running on your own machine.

**GA4 Analytics** adds six tools to OpenClaw so an agent can answer questions about a GA4
property: what the top pages were last month, where traffic came from, what changed since
last year, who is on the site right now. It calls Google's REST API directly — no gateway,
no vendor account, no Python. It is for people who run OpenClaw locally, and who would
rather read a plugin's whole network surface than trust a description of it. That surface
is one runtime dependency, three allowed hosts, and one OAuth scope.

## What it does

| Tool | What it returns |
| --- | --- |
| `ga4_report` | One preset report — top pages, traffic sources, channels, countries, devices, events, ecommerce and more — as a markdown table. |
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

```bash
openclaw plugins install openclaw-plugin-ga4
```

Requires OpenClaw `>=2026.5.17`. Then add a config entry:

```json
{
  "plugins": {
    "entries": {
      "ga4": {
        "enabled": true,
        "config": {
          "credentials": "~/.openclaw/credentials/ga4.json",
          "propertyId": "123456789"
        }
      }
    }
  }
}
```

`credentials` is optional. Without it the plugin looks at `GOOGLE_APPLICATION_CREDENTIALS`,
then at `~/.config/gcloud/application_default_credentials.json`, in that order — so if you
already authenticated for another Google tool, you are already set up.

## Setup

Five steps, about seven minutes. [SETUP.md](SETUP.md) has the click-by-click version with
console links.

1. **Create a Google Cloud project** and enable the Google Analytics Data API. Enable the
   Admin API too if you want `ga4_diagnose` to list your properties by name; reports work
   without it.
2. **Create a service account.** Skip the "grant this service account access to project"
   step — a Cloud IAM role does nothing for GA4 access.
3. **Download a JSON key**, move it somewhere private, and `chmod 600` it. That file is a
   password.
4. **Grant the service account read access in Google Analytics.** This is the step
   everyone gets wrong. Copy the `client_email` from the key file — it looks like
   `something@project.iam.gserviceaccount.com` — then open Google Analytics, go to
   **Admin > Property access management**, click **+ > Add users**, paste that address,
   untick "Notify new users by email", and give it **Viewer** and nothing else. Access is
   granted here, inside Analytics, not in Google Cloud. Skipping this produces a 403 that
   says nothing useful; `ga4_diagnose` translates it.
5. **Point the plugin at the key and the property id**, then run `ga4_diagnose`. The
   property id is the 9–10 digit number under **Admin > Property details** — not the
   `G-XXXXXXXXXX` measurement ID from your site's tag. Paste the measurement ID and the
   plugin will tell you which number you actually need.

## Why this one

- **One runtime dependency.** `typebox`, which OpenClaw already depends on and which has no
  dependencies of its own. OAuth is a signed JWT built with `node:crypto`; the API is called
  with `fetch`. No gRPC stack, no generated protos, no `google-auth-library`, no Python
  virtualenv. You can read the whole client in one sitting.
- **An egress allowlist enforced in code.** Every request goes through one guard that
  rejects any host other than `oauth2.googleapis.com`, `analyticsdata.googleapis.com` and
  `analyticsadmin.googleapis.com`, before the request is made. A test scans the built
  bundle and fails if any other host appears in it.
- **Read-only by scope.** The only scope requested is
  `https://www.googleapis.com/auth/analytics.readonly`, and a test asserts no other
  `googleapis.com/auth/` string exists in the shipped bundle.
- **No telemetry, and no report data on disk.** No phone-home, no update check, no usage
  counter. Tokens are held in memory only — a cached Google access token in a file is a
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
| [`byungkyu/google-analytics`](https://clawhub.ai/byungkyu/google-analytics) — the most-installed GA4 skill on ClawHub, ~11,189 installs | Proxies the user's Google OAuth token through `api.maton.ai`, and exposes the write-capable Admin API. | Your credentials stay on your machine and go only to Google. Three allowed hosts, `analytics.readonly` scope, no write path. |
| [`adamkristopher/ga4-api-toolkit`](https://github.com/adamkristopher/ga4-api-toolkit) | `src/api/reports.ts` `runReport()` accepts `filters` and `orderBy`, then never uses them when building the request — a filtered question returns whole-site numbers with no error. It also defaults `save=true`, writing results to disk. | A parameter this plugin cannot honour raises an error naming why, rather than being dropped — asking `overview` for a filter says that report has no dimension to filter on. Ranked presets carry an explicit sort; single-row summaries do not, because sorting one row means nothing. Nothing writes report data to disk. |
| [`jdrhyne/agent-skills`](https://github.com/jdrhyne/agent-skills) GA4 skill | Shells out to Python, requiring `uv` and a virtualenv. | A TypeScript plugin. No host binaries, no `pip`, no shell tool. |

## Analytics data is untrusted input

GA4 dimension values are not written by you. They are written by whoever visited your site.
Anyone can open `yoursite.com/?<any text they like>` and that text lands in `pagePath` and
`pagePathPlusQueryString` in tomorrow's report. The same goes for `pageTitle`,
`pageReferrer`, `landingPage`, `sessionCampaignName` and every other visitor-derived or
marketer-written field. Referrer spam has been doing this to Google Analytics for a decade
for SEO reasons. An agent that reads those values turns it into a prompt-injection channel.

This plugin does two things about it:

1. Every tool registers with `resultContentSource: "network"`, OpenClaw's marker for
   externally controlled content, so results are labelled as untrusted rather than as
   trusted tool output.
2. Rows are rendered inside a fenced block introduced as data supplied by site visitors,
   rather than interpolated into prose. Values have `|` escaped and newlines collapsed, so
   a row cannot forge table structure or start a line of its own.

This reduces risk. It does not eliminate prompt injection, and nothing does. If you wire an
agent to act on GA4 data — send email, file tickets, change bids — keep a human in that
loop. The numbers are trustworthy. The strings are not.

## Privacy

Full detail in [PRIVACY.md](PRIVACY.md). The short version:

- Dimension values pass through redaction before the model sees them: emails, phone
  numbers, UUIDs, JWTs, card numbers confirmed by Luhn, long opaque tokens, and the values
  of query parameters outside a keep-list. The report says how many values were masked.
- `userId` and user-scoped custom dimensions are refused unless you explicitly opt in.
- The plugin never calls `properties.audienceExports`, `properties.audienceLists` or
  `runAccessReport` — the only Data API surfaces that return per-person rows — and a test
  asserts those strings are absent from the built bundle.
- **What this does not protect you from:** report data returned to the agent is seen by
  whatever model provider you have configured. This plugin controls what leaves Google and
  what reaches your machine. It has no say in what your own LLM provider does with a report
  once the agent reads it. Choose the property, the date range and the provider accordingly.

## Development

```bash
npm install
npm test              # vitest, no network, no credentials
npm run typecheck
npm run plugin:validate
```

`plugin:validate` builds and then runs OpenClaw's own manifest and entry validation through
`scripts/openclaw-sandbox.sh`. That wrapper exists because `openclaw plugins build|validate`
boots enough of the runtime to run config doctor and state migrations — against a real
installation, that can rewrite your config and relocate your state files. The script
redirects `HOME`, the XDG config/state/data directories and the OpenClaw config and state
directories into a throwaway `.sandbox/` inside the repo, so a plugin build can never touch
your own OpenClaw setup.

The design decisions, and what was rejected, are in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT © 2026 Anatoli Iliev <anatoli@evamber.com>. See [LICENSE](LICENSE).

## Trademarks

This is an independent open-source project. It is not affiliated with, endorsed by, or
sponsored by Google LLC. Google Analytics and GA4 are trademarks of Google LLC.
