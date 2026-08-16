import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ga4Error, diagnose } from "./errors.js";
import { Ga4HttpError } from "./http.js";
import { shippedSources } from "../testing/files.test-support.js";

const NOW = Date.parse("2026-08-14T10:00:00Z");
const now = () => NOW;

function googleError(
  status: number,
  body: unknown,
  serverDate: Date | undefined = new Date(NOW),
): Ga4HttpError {
  return new Ga4HttpError(status, body, "google said no", serverDate);
}

function serviceDisabled(service: string) {
  return {
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          metadata: { service, consumer: "projects/482910" },
        },
        {
          "@type": "type.googleapis.com/google.rpc.Help",
          links: [{ url: `https://console.developers.google.com/apis/api/${service}` }],
        },
      ],
    },
  };
}

describe("clock skew, checked before anything else", () => {
  it("names skew rather than blaming the credential", () => {
    const error = diagnose(
      googleError(401, { error: { status: "UNAUTHENTICATED" } }, new Date(NOW + 300_000)),
      { now },
    );
    expect(error.code).toBe("CLOCK_SKEW");
    expect(error.message).toContain("300 seconds");
  });

  it("reports which way the clock is wrong", () => {
    const behind = diagnose(googleError(400, {}, new Date(NOW + 120_000)), { now });
    expect(behind.message).toContain("behind");
    const ahead = diagnose(googleError(400, {}, new Date(NOW - 120_000)), { now });
    expect(ahead.message).toContain("ahead of");
  });

  it("gives the command that fixes it", () => {
    const error = diagnose(googleError(400, {}, new Date(NOW + 120_000)), { now });
    expect(error.fix).toContain("set-ntp true");
  });

  it("reassures the user their credentials are fine", () => {
    const error = diagnose(googleError(400, {}, new Date(NOW + 120_000)), { now });
    expect(error.fix).toMatch(/credentials are fine/i);
  });

  it("tolerates ordinary drift", () => {
    const error = diagnose(
      googleError(429, { error: { status: "RESOURCE_EXHAUSTED" } }, new Date(NOW + 30_000)),
      { now },
    );
    expect(error.code).toBe("QUOTA_EXHAUSTED");
  });

  it("copes with a response that carries no Date header", () => {
    expect(diagnose(googleError(404, {}, undefined), { now }).code).toBe("PROPERTY_NOT_FOUND");
  });
});

describe("API enablement", () => {
  it("distinguishes the Data API being disabled", () => {
    const error = diagnose(googleError(403, serviceDisabled("analyticsdata.googleapis.com")), { now });
    expect(error.code).toBe("DATA_API_DISABLED");
    expect(error.message).toContain("482910");
    expect(error.fix).toContain("https://console.developers.google.com/apis/api/analyticsdata.googleapis.com");
  });

  it("distinguishes the Admin API, which is a separate enablement", () => {
    const error = diagnose(googleError(403, serviceDisabled("analyticsadmin.googleapis.com")), { now });
    expect(error.code).toBe("ADMIN_API_DISABLED");
    expect(error.message).toMatch(/separate API/);
  });

  it("offers a way to keep working while the Admin API is off", () => {
    const error = diagnose(googleError(403, serviceDisabled("analyticsadmin.googleapis.com")), { now });
    expect(error.fix).toMatch(/numeric property id directly/);
  });
});

describe("property access", () => {
  it("names the principal that needs granting", () => {
    const error = diagnose(googleError(403, { error: { status: "PERMISSION_DENIED" } }), {
      now,
      principal: "reader@example.iam.gserviceaccount.com",
      propertyId: "123456789",
    });
    expect(error.code).toBe("NO_PROPERTY_ACCESS");
    expect(error.message).toContain("reader@example.iam.gserviceaccount.com");
    expect(error.message).toContain("property 123456789");
  });

  it("gives the exact Google Analytics screen to use", () => {
    const error = diagnose(googleError(403, { error: { status: "PERMISSION_DENIED" } }), { now });
    expect(error.fix).toContain("Admin > Property access management");
    expect(error.fix).toContain("Viewer");
  });

  it("is honest that 403 cannot distinguish absent from forbidden", () => {
    const error = diagnose(googleError(403, { error: { status: "PERMISSION_DENIED" } }), { now });
    expect(error.message).toMatch(/same answer whether the property does not exist/);
  });
});

describe("credentials", () => {
  it("separates a missing credential from a rejected one", () => {
    const missing = diagnose(
      googleError(401, {
        error: {
          status: "UNAUTHENTICATED",
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CREDENTIALS_MISSING" },
          ],
        },
      }),
      { now },
    );
    expect(missing.code).toBe("CREDENTIALS_MISSING");

    const rejected = diagnose(googleError(401, { error: { status: "UNAUTHENTICATED" } }), { now });
    expect(rejected.code).toBe("CREDENTIALS_REJECTED");
    expect(rejected.fix).toMatch(/revoked or deleted/);
  });
});

describe("quota and server errors", () => {
  it("marks quota exhaustion retryable and says when it resets", () => {
    const error = diagnose(googleError(429, { error: { status: "RESOURCE_EXHAUSTED" } }), { now });
    expect(error.retryable).toBe(true);
    expect(error.fix).toMatch(/midnight US Pacific/);
  });

  it("puts a server error on Google rather than on the query", () => {
    const error = diagnose(googleError(503, { error: { status: "UNAVAILABLE" } }), { now });
    expect(error.code).toBe("GOOGLE_SERVER_ERROR");
    expect(error.message).toMatch(/on Google's side/);
    expect(error.retryable).toBe(true);
  });

  it("explains why it stops retrying server errors", () => {
    const error = diagnose(googleError(500, {}), { now });
    expect(error.fix).toMatch(/hourly allowance/);
  });
});

describe("credential containment", () => {
  it("never lets key material through into a message", () => {
    const error = diagnose(
      new Ga4HttpError(
        400,
        {},
        'assertion failed for -----BEGIN PRIVATE KEY-----MIIEvQIB and Bearer ya29.secret',
        undefined,
      ),
      { now },
    );
    const rendered = error.toString();
    expect(rendered).not.toContain("MIIEvQIB");
    expect(rendered).not.toContain("ya29.secret");
  });

  it("passes an already-diagnosed error straight through", () => {
    const original = new Ga4Error("CUSTOM", "message", "fix");
    expect(diagnose(original, { now })).toBe(original);
  });

  it("handles a non-HTTP failure without leaking anything", () => {
    const error = diagnose(new Error("socket hang up"), { now });
    expect(error.code).toBe("UNEXPECTED");
    expect(error.fix).toContain("ga4_diagnose");
  });
});

describe("presentation", () => {
  it("always carries a fix and renders it after the message", () => {
    const error = diagnose(googleError(400, {}), { now });
    expect(error.fix.length).toBeGreaterThan(0);
    expect(error.toString()).toBe(`${error.message}\n\n${error.fix}`);
  });
});

describe("one code per state", () => {
  it("has exactly one code for missing credentials", () => {
    const sources = ["src/runtime.ts", "src/ga4/errors.ts", "src/auth/credentials.ts"]
      .map((f) => readFileSync(f, "utf8")).join("\n");
    expect(sources).not.toContain("NO_CREDENTIALS");
    expect(sources).toContain("CREDENTIALS_MISSING");
  });

  it("never raises NO_CREDENTIALS anywhere in the shipped source", () => {
    const offenders = shippedSources().filter((file) => readFileSync(file, "utf8").includes("NO_CREDENTIALS"));
    expect(offenders).toEqual([]);
  });
});

// The plugins.entries sweep that used to live here now covers the shipped
// documentation as well as the shipped source, so it moved to
// src/docs.test.ts ("no references to the retired plugin config path") rather
// than existing in two halves. Nothing about it is specific to the error
// taxonomy; it landed here because an error message was where the string was
// first found.
