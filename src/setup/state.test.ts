import { describe, expect, it } from "vitest";
import { BLOCKED_ON_VALUES, setupStateFrom } from "./state.js";

const pass = (label: string) => ({ label, status: "pass" as const, detail: "" });
const fail = (label: string, code: string) => ({ label, status: "fail" as const, detail: "", code });

describe("setupStateFrom", () => {
  it("reports ok when every check passes", () => {
    const state = setupStateFrom([pass("Google credentials"), pass("Data API report")]);
    expect(state).toMatchObject({ ok: true, blocked_on: "ok" });
    expect(state.next).toBeUndefined();
  });

  it("returns only the FIRST failure, not all of them", () => {
    const state = setupStateFrom([
      fail("Google credentials", "CREDENTIALS_MISSING"),
      fail("Admin API and property access", "NO_PROPERTY_ACCESS"),
      fail("Data API report", "DATA_API_DISABLED"),
    ]);
    expect(state.blocked_on).toBe("no_credentials");
    expect(JSON.stringify(state)).not.toContain("no_property_grant");
  });

  it("hands back the exact string to paste for a missing grant", () => {
    const state = setupStateFrom(
      [pass("Google credentials"), fail("Admin API and property access", "NO_PROPERTY_ACCESS")],
      "reader@demo.iam.gserviceaccount.com",
    );
    expect(state.blocked_on).toBe("no_property_grant");
    expect(state.next?.paste).toBe("reader@demo.iam.gserviceaccount.com");
    expect(state.next?.role).toBe("Viewer");
    expect(state.url).toContain("analytics.google.com");
  });

  it("distinguishes a measurement id from a missing property", () => {
    expect(setupStateFrom([fail("Property selection", "PROPERTY_NOT_FOUND")]).blocked_on)
      .toBe("wrong_property");
    expect(setupStateFrom([fail("Property selection", "NO_PROPERTY")]).blocked_on)
      .toBe("no_property_selected");
  });

  it("treats a missing Admin API as non-blocking when reports still work", () => {
    const state = setupStateFrom([
      pass("Google credentials"),
      fail("Admin API and property access", "ADMIN_API_DISABLED"),
      pass("Data API report"),
    ]);
    expect(state.ok).toBe(true);
    expect(state.blocked_on).toBe("ok");
  });

  it("never emits a blocked_on value outside the declared set", () => {
    for (const code of ["CREDENTIALS_MISSING", "CLOCK_SKEW", "QUOTA_EXHAUSTED", "UNEXPECTED"]) {
      expect(BLOCKED_ON_VALUES).toContain(setupStateFrom([fail("x", code)]).blocked_on);
    }
  });

  it("still blocks on a disabled Admin API when no later check proves reports work", () => {
    // The skip only applies when a *later* check passed. Here nothing after
    // it did (there is nothing after it at all), so it must still be the one
    // thing reported, not silently treated as fine.
    const state = setupStateFrom([
      pass("Google credentials"),
      fail("Admin API and property access", "ADMIN_API_DISABLED"),
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
      pass("Google credentials"),
      pass("Admin API and property access"),
      pass("Data API report"),
      { label: "Privacy settings", status: "fail" as const, detail: "redaction is off" },
    ]);
    expect(state.ok).toBe(true);
    expect(state.blocked_on).toBe("ok");
  });

  it("keeps only the service-account address, nothing else from the credential, in the JSON", () => {
    // The address handed back for no_property_grant comes from a key file.
    // Nothing else about that file (its path, its key material, any other
    // credential field) may travel into this output alongside it.
    const state = setupStateFrom(
      [pass("Google credentials"), fail("Admin API and property access", "NO_PROPERTY_ACCESS")],
      "reader@demo.iam.gserviceaccount.com",
    );
    const json = JSON.stringify(state);
    expect(json).toContain("reader@demo.iam.gserviceaccount.com");
    expect(json).not.toMatch(/private_key|BEGIN PRIVATE KEY|client_secret|refresh_token|token_uri|\.json/i);
  });
});
