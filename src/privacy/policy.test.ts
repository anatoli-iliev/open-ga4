import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESS_POLICY,
  PolicyError,
  assertDimensionsAllowed,
  assertPropertyAllowed,
  classifyDimension,
  normalizePropertyId,
} from "./policy.js";

describe("classifyDimension", () => {
  it.each(["userId", "customUser:crm_id", "customUser:hashed_email"])(
    "treats %s as user-identifying",
    (name) => {
      expect(classifyDimension(name)).toBe("user-identifying");
    },
  );

  it.each([
    "pagePath",
    "pageLocation",
    "landingPagePlusQueryString",
    "pageTitle",
    "searchTerm",
    "linkUrl",
    "fileName",
    "customEvent:order_ref",
    "customItem:sku_note",
  ])("treats %s as free text", (name) => {
    expect(classifyDimension(name)).toBe("free-text");
  });

  it.each(["date", "country", "deviceCategory", "sessionSource", "sessionDefaultChannelGroup"])(
    "treats %s as ordinary",
    (name) => {
      expect(classifyDimension(name)).toBe("ordinary");
    },
  );
});

describe("assertDimensionsAllowed", () => {
  it("permits ordinary dimensions under the default policy", () => {
    expect(() =>
      assertDimensionsAllowed(["date", "country"], DEFAULT_ACCESS_POLICY),
    ).not.toThrow();
  });

  it("permits free-text dimensions, which are redacted rather than blocked", () => {
    expect(() =>
      assertDimensionsAllowed(["pagePath", "pageTitle"], DEFAULT_ACCESS_POLICY),
    ).not.toThrow();
  });

  it("blocks userId by default", () => {
    expect(() => assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY)).toThrow(PolicyError);
  });

  it("blocks user-scoped custom dimensions by default", () => {
    expect(() => assertDimensionsAllowed(["customUser:crm_id"], DEFAULT_ACCESS_POLICY)).toThrow(
      /customUser:crm_id/,
    );
  });

  it("names the exact config key that turns the block off", () => {
    expect(() => assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY)).toThrow(
      /plugins\.entries\.ga4\.config\.privacy\.allowUserIdentifyingDimensions/,
    );
  });

  it("suggests the aggregate metric that usually answers the real question", () => {
    expect(() => assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY)).toThrow(
      /totalUsers or activeUsers/,
    );
  });

  it("lists every blocked dimension, not just the first", () => {
    expect(() =>
      assertDimensionsAllowed(["userId", "customUser:crm_id"], DEFAULT_ACCESS_POLICY),
    ).toThrow(/userId, customUser:crm_id/);
  });

  it("permits them once explicitly opted in", () => {
    expect(() =>
      assertDimensionsAllowed(["userId"], {
        ...DEFAULT_ACCESS_POLICY,
        allowUserIdentifyingDimensions: true,
      }),
    ).not.toThrow();
  });
});

describe("assertPropertyAllowed", () => {
  it("allows any property when no allowlist is configured", () => {
    expect(() => assertPropertyAllowed("123456789", DEFAULT_ACCESS_POLICY)).not.toThrow();
  });

  it("allows a listed property", () => {
    expect(() =>
      assertPropertyAllowed("123456789", {
        ...DEFAULT_ACCESS_POLICY,
        propertyAllowlist: ["123456789", "987654321"],
      }),
    ).not.toThrow();
  });

  it("refuses an unlisted property and shows what is listed", () => {
    expect(() =>
      assertPropertyAllowed("555000111", {
        ...DEFAULT_ACCESS_POLICY,
        propertyAllowlist: ["123456789"],
      }),
    ).toThrow(/555000111 is not in this plugin's allowlist \(123456789\)/);
  });
});

describe("normalizePropertyId", () => {
  it.each([
    ["123456789", "123456789"],
    ["properties/123456789", "123456789"],
    ["  123456789  ", "123456789"],
  ])("reads %o as %s", (input, expected) => {
    expect(normalizePropertyId(input)).toBe(expected);
  });

  it("explains that a measurement id is not a property id", () => {
    expect(() => normalizePropertyId("G-ABC123XYZ")).toThrow(/measurement id/);
  });

  it("tells the user exactly where to find the real property id", () => {
    expect(() => normalizePropertyId("G-ABC123XYZ")).toThrow(/Admin > Property details/);
  });

  it("recognises a lowercase measurement id too", () => {
    expect(() => normalizePropertyId("g-abc123xyz")).toThrow(/measurement id/);
  });

  it.each(["GT-ABC123", "AW-12345", "DC-9999"])("recognises %s as the wrong kind of id", (input) => {
    expect(() => normalizePropertyId(input)).toThrow(/Google tag or Ads id/);
  });

  it("points at ga4_properties when the input is empty", () => {
    expect(() => normalizePropertyId("   ")).toThrow(/ga4_properties/);
  });

  it("rejects something too short to be a property id", () => {
    expect(() => normalizePropertyId("1234")).toThrow(/not a GA4 property id/);
  });

  it("rejects a UA property id", () => {
    expect(() => normalizePropertyId("UA-12345-1")).toThrow(PolicyError);
  });
});
