# Privacy behaviour of `openclaw-plugin-ga4`

## 1. What this document is

A specification of what the code does, not a promise about what we intend. Every
guarantee names the file that enforces it and the test that proves it. If a
claim here and the code disagree, the code is right and this document is a bug.

| Guarantee | Enforced in | Proven by |
| --- | --- | --- |
| Only three Google hosts are ever contacted | `src/ga4/http.ts` — `assertAllowedUrl`, before every `fetch` | `src/ga4/http.test.ts`, `src/privacy/surface.test.ts` |
| Only one OAuth scope is ever requested | `src/auth/jwt.ts` — one `ANALYTICS_READONLY_SCOPE` constant | `src/privacy/surface.test.ts` |
| No per-person Google API surface is called | `src/ga4/client.ts` — five read methods, the whole client | `src/privacy/surface.test.ts` |
| Dimension values are redacted before the model sees them | `src/privacy/redact.ts`, applied in `src/ga4/format.ts` | `src/privacy/redact.test.ts` |
| Person-identifying dimensions are refused by default | `src/privacy/policy.ts` — `assertDimensionsAllowed` | `src/privacy/policy.test.ts` |
| Credentials never reach output, logs or errors | `src/privacy/redact.ts` — `redactText`, called in `src/ga4/http.ts` | `src/ga4/http.test.ts`, `src/privacy/redact.test.ts` |
| Nothing is written to disk | no writer exists outside the opt-in audit log | `src/privacy/surface.test.ts` |

The tests in `src/privacy/surface.test.ts` run against `dist/` — the bundle that
ships — not the source. Intentions do not survive a build; strings do.

## 2. What leaves your machine

Three hosts, listed as the `ALLOWED_HOSTS` constant in `src/ga4/http.ts`. Every
request goes through `guardedFetch`, which calls `assertAllowedUrl` before it
touches the network.

| Host | Why | What is sent |
| --- | --- | --- |
| `oauth2.googleapis.com` | Exchange a credential for a one-hour access token | Service account: an RS256-signed JWT assertion carrying the service-account email, the single scope, the audience, and issue/expiry times. gcloud user credential: `client_id`, `client_secret`, `refresh_token`. |
| `analyticsdata.googleapis.com` | `runReport`, `runRealtimeReport`, `metadata`, `checkCompatibility` | Bearer token, numeric property id, dimension and metric names, date ranges, any filters and sort you asked for, a row limit. |
| `analyticsadmin.googleapis.com` | `accountSummaries` — the property list `ga4_diagnose` prints | Bearer token and a page size. Nothing else. |

Never sent, to any host: your conversation, your prompts, the model's output,
your hostname, username, file paths, an install id, a version ping, or anything
resembling telemetry. No code exists that could send them (section 6).

Your private key never leaves the process: `node:crypto`
`createSign("RSA-SHA256")` signs the assertion locally in `src/auth/jwt.ts`, and
the signature goes to Google, not the key.

The check is exact-match on `URL.host`, and only `https:` passes. Tests cover
the usual bypasses — a lookalike suffix
(`analyticsdata.googleapis.com.evil.example.com`), a lookalike prefix, a
userinfo segment smuggling the real host before an `@`, a different Google API,
a non-default port, plain HTTP, a `file://` URL — and assert the refusal happens
before `fetch` is called at all.

**Caveat.** The plugin uses the `fetch` it is given. If OpenClaw is configured
with an HTTP proxy, or your machine has a TLS-intercepting middlebox, this
traffic traverses it exactly as all other OpenClaw traffic does. The allowlist
constrains which host the plugin asks for, not what your OS and your OpenClaw
configuration then do with the request.

## 3. What this plugin cannot do

**Write to Google Analytics.** The only scope requested is
`https://www.googleapis.com/auth/analytics.readonly`, defined once in
`src/auth/jwt.ts`. A test scans the built bundle for every
`https://www.googleapis.com/auth/...` string and asserts the set is exactly that
one. Google enforces this server-side regardless of what the client asks for.

**Reach a write method that does not exist.** `src/ga4/client.ts` is the
complete Google surface used: `runReport`, `runRealtimeReport`, `getMetadata`,
`checkCompatibility`, `listAccountSummaries`. Adding a sixth is a visible diff
in one hand-written file — there is no generated SDK where an update could
quietly introduce `deleteProperty`.

**Call the three per-person surfaces.** The Data and Admin APIs have exactly
three endpoints returning rows about identified individuals rather than
aggregates: `properties.audienceExports`, `properties.audienceLists`, and
`runAccessReport`. This plugin calls none of them, and
`src/privacy/surface.test.ts` walks every `.js` file in `dist/` asserting the
strings `audienceExport`, `audienceList`, `runAccessReport` and
`userDataRetention` do not appear. That test is the whole claim — deliberately
narrower than "cannot read per-user data", which would be an overclaim
(section 7).

## 4. What it does to data before you see it

Every dimension value in every report passes through `redactValue`
(`src/privacy/redact.ts`) as the report is rendered in `src/ga4/format.ts`. That
is the last point at which a stray email in a URL can be stopped, so it runs on
every row of every tool's output unless you turn it off.

| Masked | Recognised as | Replaced with |
| --- | --- | --- |
| Query-parameter values not on the keep list | anything after `=` in the query string | `[redacted]` |
| JWTs | `eyJ…` with three base64url segments | `[redacted:jwt]` |
| Email addresses | including percent-encoded `%40`, which is how they usually reach GA4 | `[redacted:email]` |
| UUIDs | RFC 4122 versions 1–8 | `[redacted:uuid]` |
| Phone numbers | E.164 (`+14155552671`) and `(415) 555-2671` | `[redacted:phone]` |
| Long opaque tokens | 32+ characters of `[A-Za-z0-9_-]` with at least one digit and one letter | `[redacted:token]` |
| Card numbers | 13–19 digit runs that pass a Luhn check | `[redacted:card]` |
| Your own patterns | `privacy.extraRedactionPatterns` in config | `[redacted:custom]` |

Query strings are handled as raw text rather than round-tripped through
`new URL()`, which re-encodes relative paths into something you no longer
recognise. Identifiers sitting in a *path* segment are caught by the pattern
list instead.

Deliberately **not** masked:

- **GA4 sentinels**: `(not set)`, `(other)`, `(none)`, `(direct)`, `(no data)`,
  `(not provided)`. Literal strings GA4 emits; they carry no identity.
- **The default kept query parameters**: `utm_source`, `utm_medium`,
  `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `page`, `q`, `query`,
  `search`, `sort`, `category`, `lang`, `locale`, `ref`, `source` — what
  marketing reports are *about*. Override with `privacy.keepQueryParams`.
  Patterns still apply inside a kept parameter: `?q=ada@example.com` becomes
  `?q=[redacted:email]`.
- **Long digit runs that fail Luhn.** The Luhn check exists so
  `/product/1234567890123456` survives while `/receipt/4242424242424242` does
  not. Without it, ordinary SKUs and order numbers get mangled, reports become
  useless, and people switch redaction off — a worse outcome than a slightly
  leakier default.

Redaction is idempotent, so re-rendering a row does not double-mask it, and it
counts what it masked: a report containing masked values says how many, rather
than leaving the model to infer it from a `[redacted:email]` in a cell. Metric
values are numbers and are not redacted; column headers are GA4 field names and
are not redacted.

Separately and **not configurable**: `redactText` strips PEM private-key blocks,
`Bearer` tokens, and the JSON fields `access_token`, `refresh_token`,
`id_token`, `private_key`, `client_secret`, `api_key` and `apiKey` from every
error and log line. Applied in `guardedFetch` (`src/ga4/http.ts`) and in the
error mapper (`src/ga4/errors.ts`). There is no legitimate reason to surface a
credential, so there is no switch.

## 5. What is blocked outright

`src/privacy/policy.ts` refuses certain *questions* before a request is spent.
Blocked by default: `userId`, `signedInWithUserId`, any dimension beginning
`customUser:`, and any dimension the property's own live metadata reports as a
user-scoped custom definition — resolved at runtime in `src/runtime.ts`, so a
custom dimension added to your property after this plugin shipped is still
classified correctly with no plugin update.

The refusal names the exact key that lifts it,
`plugins.entries.ga4.config.privacy.allowUserIdentifyingDimensions`, and
suggests `totalUsers` or `activeUsers`, which answer "how many people" without
naming anyone; a test asserts the message contains both. An optional
`privacy.propertyAllowlist` refuses any property id you did not list.

**Why URL-bearing dimensions are not gated.** The obvious alternative is to
prompt for approval whenever a query touches `pagePath`, `pageLocation`,
`searchTerm` and friends, since those are where leaked identifiers actually
live. We rejected it. "What are my top pages?" is the single most common
question anyone asks an analytics tool, and a tool that interrupts the most
common question is one people stop using — or one where they click through the
prompt unread, which is worse than not prompting. Those dimensions are allowed
and redaction runs on every value of every row instead. A test in
`src/privacy/policy.test.ts` pins the choice: *"permits free-text dimensions,
which are redacted rather than blocked"*.

Those same values are visitor-authored — anyone can put a string in your
`pagePath` by visiting a URL — so rows are rendered inside a fenced block
introduced as untrusted data rather than interpolated into prose, and results
declare themselves as network-sourced content. A mitigation, not a solution.

## 6. What is stored

Nothing.

- **No report cache.** Rows are rendered and returned, never written.
- **No token file.** Access tokens live in a variable in `src/auth/token.ts` for
  their one-hour lifetime and die with the process. A cached access token on
  disk is a credential at rest the user never agreed to.
- **No credential copy.** Credential files are read from the path you
  configured. Nothing is copied, rewritten, or normalised onto disk.
- **No telemetry.** No analytics, no crash reporting, no phone-home, no update
  check. The allowlist makes this structural: there is no host it could reach.
- **In memory only, per process**: one access token, and a `Map` of GA4 field
  metadata keyed by property id. Metadata is schema — the names of your
  dimensions and metrics — not measurements.

`src/privacy/surface.test.ts` asserts no shipped file outside the audit-log
module contains `writeFile`, `appendFile`, `createWriteStream` or `mkdir`.

**The audit log is the one exception, and it is off by default.** Set
`plugins.entries.ga4.config.privacy.auditLogPath` and the plugin appends one
line per API call: timestamp, property id, tool name, fields requested. It never
records response bodies, rows, or values. It exists so you can answer "what did
the agent look at last Tuesday" without keeping the data itself.

## 7. The limits of these guarantees

Everything above concerns the boundary between your machine and Google. It does
not cover the following, and no amount of code in this repository could.

- **Report data goes to your LLM provider.** A returned report enters the
  agent's context and is sent to whatever model provider you configured OpenClaw
  to use, under that provider's terms, not ours. Redaction reduces what is in
  those rows; it does not keep them off the wire. Returning data to the model
  *is* the feature. If your threat model excludes your model provider, this
  plugin does not change that calculus.
- **Aggregate data can still identify people.** "One session, from Reykjavík, on
  an iPhone, that hit `/careers/apply`" is not anonymous in a small enough
  cohort, and no pattern can fix it, because every individual field is
  innocuous.
- **Redaction is pattern-based and will miss things.** It does not catch a name
  in a page title, a 20-character internal reference with no digits, a
  birthdate, or a format invented at your company last month.
  `privacy.extraRedactionPatterns` exists for exactly that, and using it is your
  job — the plugin does not know what your identifiers look like.
- **Google's thresholding is Google's.** When Google withholds rows covering
  very few users, the plugin surfaces that as a caveat and tells you to read the
  totals as lower bounds. It cannot say which rows were withheld or how many,
  because Google does not, and it cannot turn the behaviour on or off.
- **Redaction does not change what Google holds.** Masking happens on the way
  out of the plugin, on data Google already stored. If your site sends emails to
  GA4 in a URL, that is still true after you install this; the fix is on your
  site.
- **Visitor-authored values are attacker-controlled input.** Anyone can make a
  string appear in tomorrow's `pagePath` report by visiting a URL on your site.
  Framing rows as untrusted data helps. It is not a complete defence against
  prompt injection, and nothing is.
- **Local configuration is as trusted as your machine.** Anyone who can edit
  your OpenClaw config can set `privacy.redact` to `false` or enable
  `allowUserIdentifyingDimensions`. These are safe defaults, not access
  controls.
- **This is not legal advice or a compliance product.** No claim is made about
  your obligations under any privacy regime.

## 8. How to verify all of this yourself

From a clone of the repo, about five minutes:

```bash
# The egress allowlist, in full, in the file that enforces it.
grep -n -A6 'ALLOWED_HOSTS' src/ga4/http.ts

# Every https host in the built bundle. Expect the three above, plus
# www.googleapis.com, which appears only inside the scope identifier.
npm run build && grep -rhoE 'https://[a-z0-9.-]+' dist | sort -u

# Every OAuth scope in the source. Expect exactly one line.
grep -rn 'googleapis.com/auth' src

# The three per-person API surfaces. Expect no hits outside the test.
grep -rn 'audienceExport\|audienceList\|runAccessReport' src dist

# Anything that writes to disk. Expect nothing outside the audit log.
grep -rn 'writeFile\|appendFile\|createWriteStream' src

# The structural guarantees, asserted against dist/ rather than src/.
npx vitest run src/privacy/surface.test.ts && npm test

# The entire authentication path — key handling, signing, scope.
wc -l src/auth/jwt.ts src/auth/credentials.ts src/auth/token.ts

# The complete runtime dependency tree.
npm ls --omit=dev --all
```

The last command prints `typebox` and nothing else. That is the point of the
dependency policy: auditing this plugin's network and data behaviour is a
morning's reading, not a supply-chain investigation.

---

Not affiliated with, endorsed by, or sponsored by Google. Google Analytics and
GA4 are trademarks of Google LLC.

MIT licensed. Copyright 2026 Anatoli Iliev <anatoli@evamber.com>.
