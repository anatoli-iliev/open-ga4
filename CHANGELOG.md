# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing has been released yet. The 0.1.0 entry below describes what the first
release will be; it is kept up to date rather than frozen, because there is no
published artifact for it to be a record of.

A GitHub Actions workflow (`.github/workflows/release.yml`) now runs whenever a
GitHub release is published: it verifies the build, then publishes to ClawHub with
the source commit recorded. It has not run yet, since nothing has been released
under this name; whoever cuts the first release is the one who finds out whether it
works.

## [0.1.0] - 2026-08-14

First release. An OpenClaw skill: a folder with `SKILL.md` at its root and
runnable JavaScript beside it, installed with `openclaw skills install` and
needing no build step and no `npm install`.

An earlier draft of this release was an OpenClaw plugin, installed by cloning
the repository, running a build, and hand-editing a plugin entry into
`openclaw.json`. Every one of those is a step the intended audience does not
take, so the packaging changed and the analytics core did not.

### Commands

- `report`: 15 preset reports (overview, daily trend, top pages, landing
  pages, traffic sources, channels, countries, devices, browsers, events, key
  events, ecommerce, sales summary, new vs returning, site search terms), each
  using dimension and metric names verified against Google's published schema.
- `compare`: the same reports across two consecutive periods of equal
  length, for questions about change rather than level.
- `live`: active users in roughly the last 30 minutes, by country,
  screen or event.
- `query`: explicit dimensions, metrics, filter and sort order, for
  anything the presets do not cover.
- `fields`: searches the property's live metadata, so custom dimensions
  and metrics defined on that property are found without a skill update.
- `properties`: every property the credential can read, with its numeric id.
- `doctor`: setup checks in dependency order, each naming its own fix. Only a
  credential that cannot be found or read stops the run, because nothing after
  it can be checked without one. With `--json`, the single next thing the user must do, as a
  `blocked_on` state with a link and the exact string to paste, plus a
  `warnings` array for anything worth saying that is blocking nothing.

### Privacy and security

- Egress allowlist of three `googleapis.com` hosts, enforced before any request
  is issued. Covered by tests for lookalike domains, userinfo smuggling and
  non-default ports.
- Redaction of dimension values, on by default and turned off only by setting
  `GA4_REDACT`: emails (including percent-encoded), UUIDs, JWTs, long opaque
  tokens, Luhn-valid card numbers, E.164 phone numbers, and the values of query
  parameters outside a keep list. With it off, every report says so in its
  caveats and `doctor --json` says so in `warnings`.
- Unconditional stripping of credentials from every error message and warning
  the skill prints, which no setting can turn off.
- Person-identifying dimensions (`userId`, `signedInWithUserId`,
  `customUser:*`, and any user-scoped custom definition the property reports)
  are refused unless explicitly enabled.
- Optional per-property allowlist.
- Optional local audit log recording what was asked, never what came back.
- The four settings that weaken a privacy default are environment variables
  with no command-line equivalent, because a flag can be set by the model and
  the values the model reads are written by site visitors. Passing one as a
  flag is refused with an error saying so.
- Read-only by scope: `analytics.readonly` and nothing else.
- Tests assert against the built bundle that no per-person Google API surface
  (`audienceExports`, `audienceLists`, `runAccessReport`) is referenced, that no
  other OAuth scope appears, and that nothing writes to disk outside the audit
  log.
- Report rows are rendered inside a fence introduced as data supplied by site
  visitors, because GA4 dimension values are written by whoever visits the site
  and are an injection channel.
- No telemetry. Access tokens are held in memory only.

### Notes

- Zero runtime dependencies: no `dependencies`, no `peerDependencies`, and
  every import either relative or a `node:` builtin. OAuth assertions are
  signed with `node:crypto`; the API is called with `fetch`.
- Exit codes are a contract, since an agent reads them to decide what to say:
  0 worked, 1 an internal failure nothing can name, 2 the query is wrong, 3
  setup unfinished, 4 Google refused for a reason that is not about the query.
  The code says what to do next, not which side of the network decided it: a
  privacy refusal made here and Google's own "that query is invalid" both exit
  2 because the answer to both is to change the query, while a measurement id
  in GA4_PROPERTY_ID exits 3 (it is a setup step, and doctor has an answer for
  it) and a request the egress guard blocked exits 1 (it can only mean a defect
  in the skill). Every message says where the decision was made, so a refusal
  made on this machine is never relayed as Google's.
- Errors are diagnosed from Google's machine-readable `status` and `reason`
  fields, never from its message prose. Clock skew is detected from the
  response `Date` header and reported as clock skew rather than as a bad
  credential.
- Relative date ranges are sent as GA4 relative tokens so Google resolves them
  in the property's own time zone. A range counted back in days (`last 7 days`,
  `N days`) ends yesterday, never today, because today is partial and including
  it makes a period comparison misleading. The "so far" ranges (`this week`,
  `this month`, `this year`) do run to today and say so in their labels, as
  does `today` itself.
- Retired metric names are rewritten to their replacements
  (`conversions` becomes `keyEvents`) and the rewrite is reported.
- Licensed MIT-0, matching what ClawHub serves, so the licence a user receives
  is the licence in the repository.

[Unreleased]: https://github.com/anatoli-iliev/open-ga4/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anatoli-iliev/open-ga4/releases/tag/v0.1.0
