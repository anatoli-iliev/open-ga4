# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-14

First release.

### Tools

- `ga4_report` — 15 preset reports (overview, daily trend, top pages, landing
  pages, traffic sources, channels, countries, devices, browsers, events, key
  events, ecommerce, sales summary, new vs returning, site search terms), each
  using dimension and metric names verified against Google's published schema.
- `ga4_compare` — the same reports across two consecutive periods of equal
  length, for questions about change rather than level.
- `ga4_realtime` — active users in roughly the last 30 minutes, by country,
  screen or event.
- `ga4_query` — explicit dimensions, metrics, filters and sort order, for
  anything the presets do not cover.
- `ga4_fields` — searches the property's live metadata, so custom dimensions
  and metrics defined on that property are found without a plugin update.
- `ga4_diagnose` — ordered setup checks that stop at the first real failure and
  name its fix, and a list of every property the credential can read.

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
- Read-only by scope: `analytics.readonly` and nothing else.
- Tests assert against the built bundle that no per-person Google API surface
  (`audienceExports`, `audienceLists`, `runAccessReport`) is referenced, that no
  other OAuth scope appears, and that nothing writes to disk outside the audit
  log.
- Tool results are marked as network-sourced content, and report rows are
  rendered inside a fence sized to the data, because GA4 dimension values are
  written by site visitors and are an injection channel.
- No telemetry. Access tokens are held in memory only.

### Notes

- One runtime dependency, `typebox`. OAuth assertions are signed with
  `node:crypto`; the API is called with `fetch`.
- Errors are diagnosed from Google's machine-readable `status` and `reason`
  fields, never from its message prose. Clock skew is detected from the
  response `Date` header and reported as clock skew rather than as a bad
  credential.
- Relative date ranges are sent as GA4 relative tokens so Google resolves them
  in the property's own time zone. Ranges end yesterday, never today.
- Retired metric names are rewritten to their replacements
  (`conversions` → `keyEvents`) and the rewrite is reported.

[Unreleased]: https://github.com/anatoli-iliev/openclaw-plugin-ga4/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anatoli-iliev/openclaw-plugin-ga4/releases/tag/v0.1.0
