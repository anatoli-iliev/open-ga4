import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applicationDefaultCredentialsPath,
  parseCredentialFile,
  resolveCredentials,
} from "./credentials.js";

const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "example",
  client_email: "reader@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----\\n",
  token_uri: "https://oauth2.googleapis.com/token",
});

const AUTHORIZED_USER = JSON.stringify({
  type: "authorized_user",
  client_id: "123.apps.googleusercontent.com",
  client_secret: "shh",
  refresh_token: "1//refresh",
  quota_project_id: "example",
});

function notFound(): never {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

describe("parseCredentialFile", () => {
  it("reads a service-account key", () => {
    const credential = parseCredentialFile(SERVICE_ACCOUNT, "test");
    expect(credential.kind).toBe("service_account");
    if (credential.kind !== "service_account") throw new Error("unreachable");
    expect(credential.account.clientEmail).toBe("reader@example.iam.gserviceaccount.com");
  });

  it("unescapes a private key whose newlines survived as backslash-n", () => {
    const credential = parseCredentialFile(SERVICE_ACCOUNT, "test");
    if (credential.kind !== "service_account") throw new Error("unreachable");
    expect(credential.account.privateKey).toContain("-----BEGIN PRIVATE KEY-----\n");
    expect(credential.account.privateKey).not.toContain("\\n");
  });

  it("reads a gcloud authorized-user file", () => {
    const credential = parseCredentialFile(AUTHORIZED_USER, "test");
    expect(credential.kind).toBe("authorized_user");
    if (credential.kind !== "authorized_user") throw new Error("unreachable");
    expect(credential.refreshToken).toBe("1//refresh");
    expect(credential.quotaProjectId).toBe("example");
  });

  it("rejects malformed JSON with a plain message", () => {
    expect(() => parseCredentialFile("{oops", "test")).toThrow(/not valid JSON/);
  });

  it("rejects a service-account file that is missing its key", () => {
    const partial = JSON.stringify({ type: "service_account", client_email: "a@b.com" });
    expect(() => parseCredentialFile(partial, "test")).toThrow(/private_key/);
  });

  it("names the unsupported credential type instead of failing obscurely", () => {
    const external = JSON.stringify({ type: "external_account" });
    expect(() => parseCredentialFile(external, "test")).toThrow(/external_account/);
  });
});

describe("applicationDefaultCredentialsPath", () => {
  it("uses the gcloud config directory on Linux and macOS", () => {
    expect(applicationDefaultCredentialsPath("/home/ada", "linux")).toBe(
      "/home/ada/.config/gcloud/application_default_credentials.json",
    );
  });
});

describe("resolveCredentials", () => {
  it("falls back to GOOGLE_APPLICATION_CREDENTIALS", async () => {
    const result = await resolveCredentials({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/env/sa.json" },
      home: "/home/ada",
      readFileImpl: async (filePath) => (filePath === "/env/sa.json" ? SERVICE_ACCOUNT : notFound()),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.credential.source).toBe("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("falls back to gcloud application-default credentials", async () => {
    const result = await resolveCredentials({
      env: {},
      home: "/home/ada",
      readFileImpl: async (filePath) =>
        filePath === "/home/ada/.config/gcloud/application_default_credentials.json"
          ? AUTHORIZED_USER
          : notFound(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.credential.kind).toBe("authorized_user");
  });

  it("reports every location it checked when nothing is found", async () => {
    const result = await resolveCredentials({
      env: {},
      home: "/home/ada",
      readFileImpl: async () => notFound(),
    });
    expect(result.ok).toBe(false);
    expect(result.probes).toHaveLength(1);
    expect(result.probes[0]).toMatchObject({
      label: "gcloud application-default credentials",
      status: "absent",
    });
  });
});

describe("GA4_CREDENTIALS", () => {
  const PASTED_SERVICE_ACCOUNT = JSON.stringify({
    type: "service_account",
    project_id: "demo",
    private_key_id: "kid",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    client_email: "reader@demo.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });

  it("accepts the key's contents inline", async () => {
    const result = await resolveCredentials({ env: { GA4_CREDENTIALS: PASTED_SERVICE_ACCOUNT } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.kind).toBe("service_account");
    if (result.credential.kind !== "service_account") throw new Error("unreachable");
    expect(result.credential.account.clientEmail).toBe("reader@demo.iam.gserviceaccount.com");
  });

  it("tolerates leading whitespace before the opening brace", async () => {
    const result = await resolveCredentials({
      env: { GA4_CREDENTIALS: `\n  ${PASTED_SERVICE_ACCOUNT}` },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a path when the value is not JSON", async () => {
    const file = join(tmpdir(), `open-ga4-${process.pid}.json`);
    writeFileSync(file, PASTED_SERVICE_ACCOUNT);
    try {
      const result = await resolveCredentials({ env: { GA4_CREDENTIALS: file } });
      expect(result.ok).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("reports malformed inline JSON without echoing the value", async () => {
    const result = await resolveCredentials({ env: { GA4_CREDENTIALS: '{"private_key":"secret' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const probe = result.probes.find((p) => p.label.startsWith("GA4_CREDENTIALS"));
    expect(probe?.status).toBe("invalid");
    expect(JSON.stringify(result.probes)).not.toContain("secret");
  });

  it("takes priority over GOOGLE_APPLICATION_CREDENTIALS", async () => {
    const result = await resolveCredentials({
      env: {
        GA4_CREDENTIALS: PASTED_SERVICE_ACCOUNT,
        GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent.json",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probes[0]?.label).toContain("GA4_CREDENTIALS");
  });

  // Relocated from resolveCredentials's now-removed configuredPath option.
  // GA4_CREDENTIALS given a path is the reachable equivalent: an explicitly
  // supplied location that outranks GOOGLE_APPLICATION_CREDENTIALS.
  it("prefers a GA4_CREDENTIALS path over GOOGLE_APPLICATION_CREDENTIALS", async () => {
    const result = await resolveCredentials({
      env: { GA4_CREDENTIALS: "/keys/sa.json", GOOGLE_APPLICATION_CREDENTIALS: "/env/sa.json" },
      home: "/home/ada",
      readFileImpl: async (filePath) => {
        expect(filePath).toBe("/keys/sa.json");
        return SERVICE_ACCOUNT;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.credential.source).toBe("GA4_CREDENTIALS (file)");
  });

  it("expands a leading tilde in a GA4_CREDENTIALS path", async () => {
    const seen: string[] = [];
    await resolveCredentials({
      env: { GA4_CREDENTIALS: "~/keys/sa.json" },
      home: "/home/ada",
      readFileImpl: async (filePath) => {
        seen.push(filePath);
        return notFound();
      },
    });
    expect(seen[0]).toBe("/home/ada/keys/sa.json");
  });

  it("keeps trying after an invalid GA4_CREDENTIALS file rather than giving up", async () => {
    const result = await resolveCredentials({
      env: { GA4_CREDENTIALS: "/keys/broken.json" },
      home: "/home/ada",
      readFileImpl: async (filePath) =>
        filePath === "/keys/broken.json" ? "{oops" : AUTHORIZED_USER,
    });
    expect(result.ok).toBe(true);
    expect(result.probes.map((probe) => probe.status)).toEqual(["invalid", "used"]);
  });

  it("never puts key material into a probe for a GA4_CREDENTIALS path", async () => {
    const result = await resolveCredentials({
      env: { GA4_CREDENTIALS: "/keys/sa.json" },
      home: "/home/ada",
      readFileImpl: async () => SERVICE_ACCOUNT,
    });
    expect(JSON.stringify(result.probes)).not.toContain("PRIVATE KEY");
  });
});
