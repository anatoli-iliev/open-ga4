import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Credential } from "./credentials.js";
import { createTokenProvider } from "./token.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const SERVICE_ACCOUNT: Credential = {
  kind: "service_account",
  account: {
    clientEmail: "reader@example.iam.gserviceaccount.com",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  },
  source: "test",
};

const AUTHORIZED_USER: Credential = {
  kind: "authorized_user",
  clientId: "123.apps.googleusercontent.com",
  clientSecret: "shh",
  refreshToken: "1//refresh",
  source: "test",
};

function tokenResponse(value = "ya29.token", expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: value, expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function formOf(call: [string, RequestInit | undefined]): URLSearchParams {
  return new URLSearchParams(String(call[1]?.body ?? ""));
}

describe("createTokenProvider: service account", () => {
  it("exchanges a JWT bearer assertion for an access token", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 });

    expect(await provider.getAccessToken()).toBe("ya29.token");

    const call = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect(call[0]).toBe("https://oauth2.googleapis.com/token");
    const form = formOf(call);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")!.split(".")).toHaveLength(3);
  });

  it("form-encodes the request, because the token endpoint rejects JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    await createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 }).getAccessToken();
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("never sends the private key to Google", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    await createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 }).getAccessToken();
    expect(String(fetchImpl.mock.calls[0]![1]!.body)).not.toContain("PRIVATE");
  });
});

describe("createTokenProvider: gcloud authorized user", () => {
  it("uses the refresh-token grant", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    const provider = createTokenProvider(AUTHORIZED_USER, { fetchImpl, now: () => 1000 });

    expect(await provider.getAccessToken()).toBe("ya29.token");

    const form = formOf(fetchImpl.mock.calls[0] as [string, RequestInit | undefined]);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("1//refresh");
    expect(form.get("client_id")).toBe("123.apps.googleusercontent.com");
  });
});

describe("caching", () => {
  it("reuses a live token instead of re-authenticating", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 });

    await provider.getAccessToken();
    await provider.getAccessToken();
    await provider.getAccessToken();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("renews a minute before expiry rather than at it", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse("ya29.token", 3600));
    // Issued at t=1000 with a 3600s lifetime, so the token really expires at
    // t=4600 and the 60s skew window opens at t=4540.
    let clock = 1000;
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => clock });

    await provider.getAccessToken();

    clock = 4539;
    await provider.getAccessToken();
    expect(fetchImpl, "still outside the skew window").toHaveBeenCalledTimes(1);

    clock = 4540;
    await provider.getAccessToken();
    expect(fetchImpl, "skew window has opened, and the token is not yet expired")
      .toHaveBeenCalledTimes(2);
  });

  it("keeps using the cached token comfortably before the skew window", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse("ya29.token", 3600));
    let clock = 1000;
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => clock });

    await provider.getAccessToken();
    clock = 1000 + 3000;
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates after invalidate()", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 });

    await provider.getAccessToken();
    provider.invalidate();
    await provider.getAccessToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent callers into a single exchange", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return tokenResponse();
    });
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 });

    const tokens = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it("recovers after a failed exchange rather than caching the failure", async () => {
    const fetchImpl = vi
      .fn<FetchLikeSignature>()
      .mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }))
      .mockResolvedValueOnce(tokenResponse());
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 });

    await expect(provider.getAccessToken()).rejects.toThrow(/invalid_grant/);
    expect(await provider.getAccessToken()).toBe("ya29.token");
  });
});

type FetchLikeSignature = (input: string, init?: RequestInit) => Promise<Response>;

describe("malformed responses", () => {
  it("reports a missing access token plainly", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => 1000 });
    await expect(provider.getAccessToken()).rejects.toThrow(/no access token/i);
  });

  it("defaults to a one-hour lifetime when Google omits expires_in", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"access_token":"t"}', { status: 200 }));
    let clock = 1000;
    const provider = createTokenProvider(SERVICE_ACCOUNT, { fetchImpl, now: () => clock });

    await provider.getAccessToken();
    clock = 1000 + 3000;
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
