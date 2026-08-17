import { describe, expect, it } from "vitest";
import type { CheckId } from "../tools/discovery.js";
import { BLOCKED_ON_VALUES, setupStateFrom } from "./state.js";

const pass = (id: CheckId, label: string) => ({ id, label, status: "pass" as const, detail: "" });
const fail = (id: CheckId, label: string, code: string) => ({ id, label, status: "fail" as const, detail: "", code });

describe("setupStateFrom", () => {
  it("reports ok when every check passes", () => {
    const state = setupStateFrom([pass("credentials", "Google credentials"), pass("data_api_report", "Data API report")]);
    expect(state).toMatchObject({ ok: true, blocked_on: "ok" });
    expect(state.next).toBeUndefined();
  });

  it("returns only the FIRST failure, not all of them", () => {
    const state = setupStateFrom([
      fail("credentials", "Google credentials", "CREDENTIALS_MISSING"),
      fail("admin_api", "Admin API and property access", "NO_PROPERTY_ACCESS"),
      fail("data_api_report", "Data API report", "DATA_API_DISABLED"),
    ]);
    expect(state.blocked_on).toBe("no_credentials");
    expect(JSON.stringify(state)).not.toContain("no_property_grant");
  });

  it("hands back the exact string to paste for a missing grant", () => {
    const state = setupStateFrom(
      [pass("credentials", "Google credentials"), fail("admin_api", "Admin API and property access", "NO_PROPERTY_ACCESS")],
      "reader@demo.iam.gserviceaccount.com",
    );
    expect(state.blocked_on).toBe("no_property_grant");
    expect(state.next?.paste).toBe("reader@demo.iam.gserviceaccount.com");
    expect(state.next?.role).toBe("Viewer");
    expect(state.url).toContain("analytics.google.com");
  });

  it("distinguishes a measurement id from a missing property", () => {
    expect(setupStateFrom([fail("property_selection", "Property selection", "PROPERTY_NOT_FOUND")]).blocked_on)
      .toBe("wrong_property");
    expect(setupStateFrom([fail("property_selection", "Property selection", "NO_PROPERTY")]).blocked_on)
      .toBe("no_property_selected");
  });

  it("treats a missing Admin API as non-blocking when reports still work", () => {
    const state = setupStateFrom([
      pass("credentials", "Google credentials"),
      fail("admin_api", "Admin API and property access", "ADMIN_API_DISABLED"),
      pass("data_api_report", "Data API report"),
      pass("privacy_settings", "Privacy settings"),
    ]);
    expect(state.ok).toBe(true);
    expect(state.blocked_on).toBe("ok");
  });

  it("never emits a blocked_on value outside the declared set", () => {
    for (const code of ["CREDENTIALS_MISSING", "CLOCK_SKEW", "QUOTA_EXHAUSTED", "UNEXPECTED"]) {
      expect(BLOCKED_ON_VALUES).toContain(setupStateFrom([fail("data_api_report", "x", code)]).blocked_on);
    }
  });

  it("maps a code outside the taxonomy to unknown, never to quota", () => {
    // Reporting an unclassifiable failure as quota exhaustion sends someone
    // to wait out a limit that was never hit. UNEXPECTED and
    // GOOGLE_SERVER_ERROR are both real codes diagnose() can return from the
    // same "Data API report" call that also raises QUOTA_EXHAUSTED, but
    // neither means quota.
    for (const code of ["UNEXPECTED", "GOOGLE_SERVER_ERROR", "some_future_code_this_taxonomy_does_not_know"]) {
      const state = setupStateFrom([fail("data_api_report", "Data API report", code)]);
      expect(state.blocked_on).toBe("unknown");
    }
  });

  it("tells the agent to report the message rather than guess a fix, for an unknown code", () => {
    const state = setupStateFrom([
      {
        id: "data_api_report" as const,
        label: "Data API report",
        status: "fail" as const,
        detail: "server exploded",
        code: "GOOGLE_SERVER_ERROR",
      },
    ]);
    expect(state.blocked_on).toBe("unknown");
    expect(state.next?.action).toContain("server exploded");
    expect(state.next?.action.toLowerCase()).not.toContain("quota");
    // Must not claim a cause: no URL, since none is known to be relevant.
    expect(state.url).toBeUndefined();
  });

  it("still blocks on a disabled Admin API when no later check proves reports work", () => {
    // Mirrors the concrete failure a review caught, not a shape production
    // can never emit: Admin API disabled and no default property configured.
    // The Admin API check fails without aborting; `properties` stays empty;
    // property selection fails with NO_PROPERTY because there is nothing to
    // auto-select; the Data API report check never runs at all; and the
    // trailing Privacy settings check still passes (redaction is on by
    // default). A predicate that skips ADMIN_API_DISABLED whenever *any*
    // later check passed would be satisfied by that trailing pass alone,
    // whether or not a report ever ran, hiding the one genuine blocking step
    // and sending the user in a loop: told to run `properties` to fix
    // "no property selected", which fails with the same ADMIN_API_DISABLED.
    const state = setupStateFrom([
      pass("credentials", "Google credentials"),
      fail("admin_api", "Admin API and property access", "ADMIN_API_DISABLED"),
      fail("property_selection", "Property selection", "NO_PROPERTY"),
      pass("privacy_settings", "Privacy settings"),
    ]);
    expect(state.ok).toBe(false);
    expect(state.blocked_on).toBe("admin_api_disabled");
  });

  it("does not block on the privacy-settings check, which carries no taxonomy code", () => {
    // runDiagnose's fourth check (redaction on/off) is not part of the setup
    // taxonomy at all: it is a standing privacy posture, not a reason a
    // report cannot run, so it never carries a `code`. A check with no code
    // is not something this machine can name a blocking step for, and it is
    // not one either: reports work fine with redaction off, they are just
    // less safe. It must not be silently reinterpreted as a quota problem or
    // any other bucket.
    const state = setupStateFrom([
      pass("credentials", "Google credentials"),
      pass("admin_api", "Admin API and property access"),
      pass("data_api_report", "Data API report"),
      { id: "privacy_settings" as const, label: "Privacy settings", status: "fail" as const, detail: "redaction is off" },
    ]);
    expect(state.ok).toBe(true);
    expect(state.blocked_on).toBe("ok");
  });

  it("still says so, in warnings, rather than reporting a clean bill of health", () => {
    // Not blocking is not the same as not worth saying. This JSON is the only
    // thing an agent reads on this command, and while a failing check with no
    // code was skipped outright, `doctor --json` answered "ok: true" for a
    // setup that sends unredacted personal data to a model provider. The
    // markdown checklist said it; the channel the agent actually uses did not.
    const state = setupStateFrom([
      pass("credentials", "Google credentials"),
      pass("data_api_report", "Data API report"),
      {
        id: "privacy_settings" as const,
        label: "Privacy settings",
        status: "fail" as const,
        detail: "redaction is turned OFF",
        fix: "Unset the GA4_REDACT environment variable.",
      },
    ]);
    expect(state.blocked_on).toBe("ok");
    expect(state.warnings).toEqual(["redaction is turned OFF Unset the GA4_REDACT environment variable."]);
  });

  it("carries a warning alongside a blocking step too, rather than losing it", () => {
    // A shape runDiagnose really produces: credentials load, the Admin API is
    // off, and the privacy check still runs and still fails. (A *credentials*
    // failure could not be paired with it, because that one returns before the
    // privacy check is ever appended.)
    const state = setupStateFrom([
      pass("credentials", "Google credentials"),
      fail("admin_api", "Admin API and property access", "ADMIN_API_DISABLED"),
      fail("property_selection", "Property selection", "NO_PROPERTY"),
      {
        id: "privacy_settings" as const,
        label: "Privacy settings",
        status: "fail" as const,
        detail: "redaction is turned OFF",
      },
    ]);
    expect(state.blocked_on).toBe("admin_api_disabled");
    expect(state.warnings).toEqual(["redaction is turned OFF"]);
  });

  it("omits warnings entirely when there is nothing to warn about", () => {
    const state = setupStateFrom([pass("credentials", "Google credentials")]);
    expect(state.warnings).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("warnings");
  });

  it("keeps only the service-account address, nothing else from the credential, in the JSON", () => {
    // The address handed back for no_property_grant comes from a key file.
    // Nothing else about that file (its path, its key material, any other
    // credential field) may travel into this output alongside it.
    const state = setupStateFrom(
      [pass("credentials", "Google credentials"), fail("admin_api", "Admin API and property access", "NO_PROPERTY_ACCESS")],
      "reader@demo.iam.gserviceaccount.com",
    );
    const json = JSON.stringify(state);
    expect(json).toContain("reader@demo.iam.gserviceaccount.com");
    expect(json).not.toMatch(/private_key|BEGIN PRIVATE KEY|client_secret|refresh_token|token_uri|\.json/i);
  });
});
