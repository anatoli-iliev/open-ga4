import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANALYTICS_READONLY_SCOPE, buildAssertion, decodeSegment } from "./jwt.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const account = {
  clientEmail: "reader@example.iam.gserviceaccount.com",
  privateKey: pem,
  tokenUri: "https://oauth2.googleapis.com/token",
};

describe("buildAssertion", () => {
  it("produces three base64url segments", () => {
    const assertion = buildAssertion(account, 1_760_000_000);
    expect(assertion.split(".")).toHaveLength(3);
    expect(assertion).not.toContain("+");
    expect(assertion).not.toContain("/");
    expect(assertion).not.toContain("=");
  });

  it("declares RS256 and JWT in the header", () => {
    const [header] = buildAssertion(account, 1_760_000_000).split(".");
    expect(decodeSegment(header!)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("requests only the read-only analytics scope", () => {
    const [, payload] = buildAssertion(account, 1_760_000_000).split(".");
    expect(decodeSegment(payload!).scope).toBe(ANALYTICS_READONLY_SCOPE);
    expect(ANALYTICS_READONLY_SCOPE).toBe("https://www.googleapis.com/auth/analytics.readonly");
  });

  it("addresses the assertion to the token endpoint and signs as the service account", () => {
    const [, payload] = buildAssertion(account, 1_760_000_000).split(".");
    const claims = decodeSegment(payload!);
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.iss).toBe(account.clientEmail);
    expect(claims.sub).toBeUndefined();
  });

  it("expires one hour after issue, the maximum Google accepts", () => {
    const issuedAt = 1_760_000_000;
    const [, payload] = buildAssertion(account, issuedAt).split(".");
    const claims = decodeSegment(payload!);
    expect(claims.iat).toBe(issuedAt);
    expect(claims.exp).toBe(issuedAt + 3600);
  });

  it("produces a verifiable RS256 signature over header.payload", async () => {
    const { createVerify } = await import("node:crypto");
    const assertion = buildAssertion(account, 1_760_000_000);
    const [header, payload, signature] = assertion.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(privateKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("rejects a key that is not a PEM private key", () => {
    expect(() => buildAssertion({ ...account, privateKey: "not-a-key" }, 1)).toThrow(
      /private key/i,
    );
  });

  it("never places the private key into the assertion", () => {
    const assertion = buildAssertion(account, 1_760_000_000);
    expect(assertion).not.toContain("PRIVATE KEY");
  });
});
