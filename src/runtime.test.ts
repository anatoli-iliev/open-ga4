import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

describe("resolveProperty", () => {
  const runtime = createRuntime({ config: resolveConfig({ propertyId: "123456789" }) });

  it("falls back to the configured default", () => {
    expect(runtime.resolveProperty()).toBe("123456789");
  });

  it("prefers an explicit argument", () => {
    expect(runtime.resolveProperty("987654321")).toBe("987654321");
  });

  it("strips a properties/ prefix", () => {
    expect(runtime.resolveProperty("properties/987654321")).toBe("987654321");
  });

  it("enforces the allowlist", () => {
    const restricted = createRuntime({
      config: resolveConfig({
        propertyId: "123456789",
        privacy: { propertyAllowlist: ["555000111"] },
      }),
    });
    expect(() => restricted.resolveProperty()).toThrow(/not in this plugin's allowlist/);
    expect(restricted.resolveProperty("555000111")).toBe("555000111");
  });

  it("names the fix when there is no property at all", () => {
    const bare = createRuntime({ config: resolveConfig({}) });
    const error = (() => {
      try {
        bare.resolveProperty();
        return undefined;
      } catch (caught) {
        return caught as { message: string; fix: string };
      }
    })();
    expect(error?.message).toMatch(/No GA4 property specified/);
    expect(error?.fix).toMatch(/ga4_diagnose/);
    expect(error?.fix).toMatch(/plugins\.entries\.ga4\.config\.propertyId/);
  });
});

describe("credential loading", () => {
  it("does not touch credentials until a tool actually needs them", async () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: "/nope/missing.json" };
    const runtime = createRuntime({ config: resolveConfig({}), env });
    // Constructing the runtime and resolving a property must not throw, even
    // though the credential path is unusable.
    expect(runtime.resolveProperty("123456789")).toBe("123456789");
    expect(runtime.principal()).toBeUndefined();
  });

  it("reports every location it checked when nothing is found", async () => {
    const runtime = createRuntime({
      config: resolveConfig({ credentials: "/nope/a.json" }),
      env: {},
    });
    await expect(runtime.client()).rejects.toThrow(/No Google credentials found/);
    await expect(runtime.client()).rejects.toThrow(/plugin config \(credentials\)/);
  });

  it("points at SETUP.md and ga4_diagnose rather than a bare failure", async () => {
    const runtime = createRuntime({ config: resolveConfig({}), env: {} });
    const error = await runtime.client().then(
      () => undefined,
      (caught: { fix: string }) => caught,
    );
    expect(error?.fix).toMatch(/SETUP\.md/);
    expect(error?.fix).toMatch(/ga4_diagnose/);
  });

  it("retries discovery rather than caching a rejection for the process lifetime", async () => {
    const runtime = createRuntime({
      config: resolveConfig({ credentials: "/keys/absent.json" }),
      env: {},
    });

    // A rejected promise must not be memoised: someone who fixes their config
    // and reloads should not have to restart the gateway. Both attempts fail
    // here because the file is still absent, but the second failure proves
    // discovery ran again rather than replaying a cached rejection.
    const first = await runtime.client().catch((error: Error) => error);
    const second = await runtime.client().catch((error: Error) => error);

    expect(first).toBeInstanceOf(Error);
    expect(second).toBeInstanceOf(Error);
    expect(second).not.toBe(first);
  });
});
