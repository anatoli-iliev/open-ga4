# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing has been released yet. The 0.1.0 entry below describes what the first
release will be; it is kept up to date rather than frozen, because there is no
published artifact for it to be a record of.

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
- `doctor`: ordered setup checks that stop at the first real failure and name
  its fix. With `--json`, the single next thing the user must do, as a
  `blocked_on` state with a link and the exact string to paste.

### Privacy and security

- Egress allowlist of three `googleapis.com` hosts, enforced before any request
  is issued. Covered by tests for lookalike domains, userinfo smuggling and
  non-default ports.
- Unconditional redaction of dimension values: emails (including
  percent-encoded), UUIDs, JWTs, long opaque tokens, Luhn-valid card numbers,
  E.164 phone numbers, and the values of query parameters outside a keep list.
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
- Errors are diagnosed from Google's machine-readable `status` and `reason`
  fields, never from its message prose. Clock skew is detected from the
  response `Date` header and reported as clock skew rather than as a bad
  credential.
- Relative date ranges are sent as GA4 relative tokens so Google resolves them
  in the property's own time zone. Ranges end yesterday, never today.
- Retired metric names are rewritten to their replacements
  (`conversions` becomes `keyEvents`) and the rewrite is reported.
- Licensed MIT-0, matching what ClawHub serves, so the licence a user receives
  is the licence in the repository.

[Unreleased]: https://github.com/anatoli-iliev/open-ga4/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anatoli-iliev/open-ga4/releases/tag/v0.1.0
