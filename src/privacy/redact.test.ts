import { describe, expect, it } from "vitest";
import { DEFAULT_KEPT_QUERY_PARAMS, redactValue, redactText } from "./redact.js";

const opts = { enabled: true, keepQueryParams: DEFAULT_KEPT_QUERY_PARAMS, extraPatterns: [] };

describe("redactValue", () => {
  it("passes through a clean path unchanged", () => {
    const result = redactValue("/pricing/enterprise", opts);
    expect(result.value).toBe("/pricing/enterprise");
    expect(result.redactions).toBe(0);
  });

  it("masks an email carried in a query parameter", () => {
    const result = redactValue("/invite?to=ada@example.com", opts);
    expect(result.value).toBe("/invite?to=[redacted]");
    expect(result.redactions).toBe(1);
  });

  it("masks an email embedded in a path segment", () => {
    const result = redactValue("/u/ada@example.com/settings", opts);
    expect(result.value).toBe("/u/[redacted:email]/settings");
  });

  it("masks a percent-encoded email, which is how one usually reaches GA4", () => {
    const result = redactValue("/u/ada%40example.com", opts);
    expect(result.value).toBe("/u/[redacted:email]");
  });

  it("masks an email inside a query parameter that is otherwise kept", () => {
    const result = redactValue("/search?q=ada@example.com", opts);
    expect(result.value).toBe("/search?q=[redacted:email]");
  });

  it("masks query parameter values that are not on the keep list", () => {
    const result = redactValue("/account?session=abc123&utm_source=newsletter", opts);
    expect(result.value).toBe("/account?session=[redacted]&utm_source=newsletter");
    expect(result.redactions).toBe(1);
  });

  it("keeps every default marketing parameter readable", () => {
    const query = DEFAULT_KEPT_QUERY_PARAMS.map((name, index) => `${name}=v${index}`).join("&");
    const result = redactValue(`/landing?${query}`, opts);
    expect(result.value).toBe(`/landing?${query}`);
    expect(result.redactions).toBe(0);
  });

  it("masks a full URL query string, not just a path query string", () => {
    const result = redactValue("https://shop.example.com/cart?token=deadbeefcafe", opts);
    expect(result.value).toBe("https://shop.example.com/cart?token=[redacted]");
  });

  it("masks a UUID appearing as a path segment", () => {
    const result = redactValue("/orders/3f2504e0-4f89-41d3-9a0c-0305e82c3301", opts);
    expect(result.value).toBe("/orders/[redacted:uuid]");
  });

  it("masks a card-like number that passes a Luhn check", () => {
    const result = redactValue("/receipt/4242424242424242", opts);
    expect(result.value).toBe("/receipt/[redacted:card]");
  });

  it("leaves a long digit run that fails the Luhn check alone", () => {
    const result = redactValue("/product/1234567890123456", opts);
    expect(result.value).toBe("/product/1234567890123456");
    expect(result.redactions).toBe(0);
  });

  it("masks an E.164 phone number", () => {
    const result = redactValue("/callback/+14155552671", opts);
    expect(result.value).toBe("/callback/[redacted:phone]");
  });

  it("masks a long opaque token", () => {
    const result = redactValue("/verify/9f8e7d6c5b4a39281706f5e4d3c2b1a0ff11ee22", opts);
    expect(result.value).toBe("/verify/[redacted:token]");
  });

  it("masks a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactValue(`/sso#${jwt}`, opts).value).toContain("[redacted:jwt]");
  });

  it("applies caller-supplied extra patterns", () => {
    const result = redactValue("/u/emp-00421", {
      ...opts,
      extraPatterns: [/emp-\d+/g],
    });
    expect(result.value).toBe("/u/[redacted:custom]");
  });

  it("returns the value untouched when redaction is disabled", () => {
    const result = redactValue("/invite?to=ada@example.com", { ...opts, enabled: false });
    expect(result.value).toBe("/invite?to=ada@example.com");
    expect(result.redactions).toBe(0);
  });

  it("leaves GA4 sentinel values alone", () => {
    for (const sentinel of ["(not set)", "(other)", "(direct)", "(none)"]) {
      expect(redactValue(sentinel, opts).value).toBe(sentinel);
    }
  });

  it("is idempotent", () => {
    const once = redactValue("/invite?to=ada@example.com", opts).value;
    expect(redactValue(once, opts).value).toBe(once);
  });
});

describe("redactText", () => {
  it("masks a private key block", () => {
    const text = "failed with -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    const result = redactText(text);
    expect(result).not.toContain("MIIEvQIBADANBg");
    expect(result).toContain("[redacted:private-key]");
  });

  it("masks a bearer token", () => {
    expect(redactText("Authorization: Bearer ya29.a0AfB_byC3xyz")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("masks an access token in a JSON error body", () => {
    expect(redactText('{"access_token":"ya29.secret-value","expires_in":3599}')).toBe(
      '{"access_token":"[redacted]","expires_in":3599}',
    );
  });

  it("leaves ordinary error text alone", () => {
    const text = "Property 123456789 not found.";
    expect(redactText(text)).toBe(text);
  });
});

describe("bypasses found by adversarial audit", () => {
  it("masks a doubly percent-encoded email", () => {
    expect(redactValue("/u/ada%2540example.com", opts).value).toBe("/u/[redacted:email]");
  });

  it("masks values in a fragment, where implicit-flow tokens land", () => {
    const result = redactValue("/callback#access_token=abc123&state=xyz", opts);
    expect(result.value).toBe("/callback#access_token=[redacted]&state=[redacted]");
    expect(result.redactions).toBe(2);
  });

  it("masks a fragment that follows a query string", () => {
    const result = redactValue("/a?utm_source=news#id_token=secret", opts);
    expect(result.value).toBe("/a?utm_source=news#id_token=[redacted]");
  });

  it("still keeps a fragment with no key=value pairs readable", () => {
    expect(redactValue("/docs#installation", opts).value).toBe("/docs#installation");
  });
});
