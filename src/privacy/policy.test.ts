import { describe, expect, it } from "vitest";
import { EXIT, exitCodeFor } from "../cli/exit.js";
import { Ga4Error } from "../ga4/errors.js";
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

  it("names the exact environment variable that turns the block off", () => {
    expect(() => assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY)).toThrow(
      /GA4_ALLOW_USER_DIMENSIONS/,
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

/**
 * A name used as a filter field or a sort key is refused on the same rule, and
 * has to be explained differently.
 *
 * The refusal an agent reads decides what it tries next. Told only that `userId`
 * identifies people, the obvious repair is to take it out of the output columns
 * and ask again with it as a filter instead: the exact request being refused,
 * and one that comes back looking like an ordinary page report. So the message
 * has to say that filtering on a person is asking about that person however the
 * columns are labelled, and the suggested fix has to be an aggregate question
 * rather than "the same numbers without that dimension", which here would be
 * advice to retry the attack.
 */
describe("the refusal for a filter field or a sort key", () => {
  function messageFor(use: "columns" | "filter" | "sort"): string {
    try {
      assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY, new Set(), use);
    } catch (error) {
      return (error as PolicyError).message;
    }
    throw new Error("expected a refusal, got none");
  }

  it("still refuses on the same rule as a column", () => {
    expect(() =>
      assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY, new Set(), "filter"),
    ).toThrow(PolicyError);
    expect(() =>
      assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY, new Set(), "sort"),
    ).toThrow(PolicyError);
  });

  it("says a filter field counts even though it is not one of the columns", () => {
    expect(messageFor("filter")).toMatch(/not among the columns the report returns/);
  });

  it("closes off the wrong repair: dropping the name from the dimension list", () => {
    expect(messageFor("filter")).toMatch(
      /Leaving it out of the dimension list does not make this an aggregate question/,
    );
  });

  it("says a sort key counts even though it is not one of the columns", () => {
    expect(messageFor("sort")).toMatch(/orders the report by which person each row belongs to/);
  });

  it("keeps the opt-in and the aggregate suggestion on every channel", () => {
    for (const use of ["columns", "filter", "sort"] as const) {
      expect(messageFor(use)).toMatch(/GA4_ALLOW_USER_DIMENSIONS/);
      expect(messageFor(use)).toMatch(/totalUsers or activeUsers/);
    }
  });

  it("says nothing about columns when the name really was a column", () => {
    expect(messageFor("columns")).not.toMatch(/not among the columns/);
  });

  it("does not tell a filtered query to retry without the dimension", () => {
    try {
      assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY, new Set(), "filter");
      throw new Error("expected a refusal, got none");
    } catch (error) {
      const fix = (error as PolicyError).fix;
      expect(fix).toMatch(/without narrowing it to a person/);
      expect(fix).not.toMatch(/same numbers without that dimension/);
    }
  });

  it("permits both once explicitly opted in", () => {
    const allowed = { ...DEFAULT_ACCESS_POLICY, allowUserIdentifyingDimensions: true };
    expect(() => assertDimensionsAllowed(["userId"], allowed, new Set(), "filter")).not.toThrow();
    expect(() => assertDimensionsAllowed(["userId"], allowed, new Set(), "sort")).not.toThrow();
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
    ).toThrow(/555000111 is not in this skill's allowlist \(123456789\)/);
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

  it("points at a tool that exists when the input is empty", () => {
    expect(() => normalizePropertyId("   ")).toThrow(/Run properties/);
  });

  it("rejects something too short to be a property id", () => {
    expect(() => normalizePropertyId("1234")).toThrow(/not a GA4 property id/);
  });

  it("rejects a UA property id", () => {
    expect(() => normalizePropertyId("UA-12345-1")).toThrow(PolicyError);
  });
});

/**
 * Every refusal in this module is made on this machine, before a socket is
 * opened. What the *user* is told about that is decided by whether the error
 * is a Ga4Error: anything else falls through diagnose() into the generic
 * "UNEXPECTED" bucket, which says Google refused the request and offers "Run
 * doctor to check the setup" as the fix. That is what these assert against,
 * so the exit code and the diagnosis stay attached to the refusal rather than
 * being reconstructed by a caller.
 */
describe("what a local refusal reports itself as", () => {
  /** Runs a thrower and returns the error it produced. */
  function thrown(run: () => void): Ga4Error {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(Ga4Error);
      return error as Ga4Error;
    }
    throw new Error("expected a refusal, got none");
  }

  it("reports a blocked dimension as bad input, not as a refusal from Google", () => {
    const error = thrown(() => assertDimensionsAllowed(["userId"], DEFAULT_ACCESS_POLICY));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(exitCodeFor(error)).toBe(EXIT.BAD_INPUT);
    expect(error.fix).not.toMatch(/Run doctor/);
    expect(error.fix).toMatch(/Google was never asked/);
  });

  it("reports a property outside the allowlist as bad input", () => {
    const error = thrown(() =>
      assertPropertyAllowed("555000111", {
        ...DEFAULT_ACCESS_POLICY,
        propertyAllowlist: ["123456789"],
      }),
    );
    expect(error.code).toBe("INVALID_REQUEST");
    expect(exitCodeFor(error)).toBe(EXIT.BAD_INPUT);
    expect(error.fix).toMatch(/Nothing was sent to Google/);
  });

  it.each(["G-ABC123XYZ", "GT-ABC123", "AW-12345"])(
    "routes %s to the wrong-property setup step rather than to a Google refusal",
    (input) => {
      // PROPERTY_NOT_FOUND is what src/setup/state.ts maps to
      // blocked_on: "wrong_property", the step written for exactly this
      // mistake. Exit 3 sends the agent to doctor, and doctor now has an
      // answer for it, which is what makes that route terminate.
      const error = thrown(() => normalizePropertyId(input));
      expect(error.code).toBe("PROPERTY_NOT_FOUND");
      expect(exitCodeFor(error)).toBe(EXIT.SETUP_INCOMPLETE);
    },
  );

  it("reports a value that identifies nothing at all as bad input", () => {
    const error = thrown(() => normalizePropertyId("banana"));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(exitCodeFor(error)).toBe(EXIT.BAD_INPUT);
  });

  it("reports a blank property the same way as none configured at all", () => {
    const error = thrown(() => normalizePropertyId("   "));
    expect(error.code).toBe("NO_PROPERTY");
    expect(exitCodeFor(error)).toBe(EXIT.SETUP_INCOMPLETE);
  });
});
