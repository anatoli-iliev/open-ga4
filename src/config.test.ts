import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "./config.js";

describe("configFromEnv", () => {
  it("defaults to redaction on and user dimensions blocked", () => {
    const config = configFromEnv({});
    expect(config.redaction.enabled).toBe(true);
    expect(config.access.allowUserIdentifyingDimensions).toBe(false);
    expect(config.access.propertyAllowlist).toEqual([]);
    expect(config.auditLogPath).toBeUndefined();
  });

  it("reads the property id", () => {
    expect(configFromEnv({ GA4_PROPERTY_ID: "123456789" }).defaultPropertyId).toBe("123456789");
  });

  it("turns redaction off only for an explicit false value", () => {
    expect(configFromEnv({ GA4_REDACT: "0" }).redaction.enabled).toBe(false);
    expect(configFromEnv({ GA4_REDACT: "false" }).redaction.enabled).toBe(false);
    expect(configFromEnv({ GA4_REDACT: "" }).redaction.enabled).toBe(true);
    expect(configFromEnv({ GA4_REDACT: "yes please" }).redaction.enabled).toBe(true);
  });

  it("permits user dimensions only for an explicit true value", () => {
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "1" }).access.allowUserIdentifyingDimensions).toBe(true);
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "true" }).access.allowUserIdentifyingDimensions).toBe(true);
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "0" }).access.allowUserIdentifyingDimensions).toBe(false);
    expect(configFromEnv({ GA4_ALLOW_USER_DIMENSIONS: "maybe" }).access.allowUserIdentifyingDimensions).toBe(false);
  });

  it("splits the property allowlist and drops empty entries", () => {
    expect(configFromEnv({ GA4_PROPERTY_ALLOWLIST: "111, 222 ,,333" }).access.propertyAllowlist)
      .toEqual(["111", "222", "333"]);
  });

  it("warns and continues when GA4_PROPERTY_ALLOWLIST holds a non-numeric id", () => {
    const warn = vi.fn();
    const config = configFromEnv({ GA4_PROPERTY_ALLOWLIST: "111,not-an-id" }, warn);
    expect(config.access.propertyAllowlist).toEqual(["111"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not-an-id"));
  });

  it("uses the default row limit when unset", () => {
    expect(configFromEnv({}).defaultRowLimit).toBeGreaterThan(0);
  });
});
