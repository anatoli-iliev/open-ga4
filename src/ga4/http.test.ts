import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_HOSTS,
  EgressBlockedError,
  Ga4HttpError,
  assertAllowedUrl,
  guardedFetch,
} from "./http.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the egress allowlist", () => {
  it("names exactly the three Google hosts this plugin needs", () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual([
      "analyticsadmin.googleapis.com",
      "analyticsdata.googleapis.com",
      "oauth2.googleapis.com",
    ]);
  });

  it("admits each allowlisted host", () => {
    for (const host of ALLOWED_HOSTS) {
      expect(() => assertAllowedUrl(`https://${host}/v1beta/x`)).not.toThrow();
    }
  });

  it.each([
    ["an unrelated host", "https://evil.example.com/steal"],
    ["a lookalike suffix", "https://analyticsdata.googleapis.com.evil.example.com/x"],
    ["a lookalike prefix", "https://notanalyticsdata.googleapis.com/x"],
    ["a different Google API", "https://gmail.googleapis.com/v1/messages"],
    ["userinfo smuggling the real host", "https://analyticsdata.googleapis.com@evil.example.com/x"],
    ["plain http", "http://analyticsdata.googleapis.com/v1beta/x"],
    ["a file URL", "file:///etc/passwd"],
    ["a non-URL", "not-a-url"],
  ])("blocks %s", (_label, url) => {
    expect(() => assertAllowedUrl(url)).toThrow(EgressBlockedError);
  });

  it("blocks an allowlisted host reached on a non-default port", () => {
    expect(() => assertAllowedUrl("https://analyticsdata.googleapis.com:8443/x")).toThrow(
      EgressBlockedError,
    );
  });

  it("refuses a blocked request before any network call is attempted", async () => {
    const fetchImpl = vi.fn();
    await expect(guardedFetch("https://evil.example.com/x", { fetchImpl })).rejects.toThrow(
      EgressBlockedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains itself when it blocks", () => {
    expect(() => assertAllowedUrl("https://evil.example.com/x")).toThrow(
      /may only contact .*analyticsdata\.googleapis\.com/,
    );
  });
});

describe("guardedFetch", () => {
  it("returns the parsed body on success", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ rowCount: 3 }));
    const body = await guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", { fetchImpl });
    expect(body).toEqual({ rowCount: 3 });
  });

  it("sends a bearer token when one is supplied", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}));
    await guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", {
      fetchImpl,
      accessToken: "token-value",
    });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-value");
  });

  it("sends no authorization header when there is no token", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}));
    await guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", { fetchImpl });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("POSTs JSON when given a body and GETs otherwise", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}));
    await guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", { fetchImpl });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe("GET");

    await guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", {
      fetchImpl,
      body: { limit: 10 },
    });
    const init = fetchImpl.mock.calls[1]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"limit":10}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("raises a Ga4HttpError carrying the status and parsed body", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(
        { error: { code: 403, message: "User does not have sufficient permissions.", status: "PERMISSION_DENIED" } },
        403,
      ),
    );
    const error = await guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", { fetchImpl })
      .then(() => null)
      .catch((caught: unknown) => caught as Ga4HttpError);

    expect(error).toBeInstanceOf(Ga4HttpError);
    expect(error!.status).toBe(403);
    expect(error!.message).toBe("User does not have sufficient permissions.");
    expect((error!.body as { error: { status: string } }).error.status).toBe("PERMISSION_DENIED");
  });

  it("reads the OAuth endpoint's flat error shape", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400),
    );
    await expect(
      guardedFetch("https://oauth2.googleapis.com/token", { fetchImpl }),
    ).rejects.toThrow("invalid_grant: Invalid JWT Signature.");
  });

  it("strips credentials out of error messages", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: { message: 'bad assertion {"private_key":"-----BEGIN PRIVATE KEY-----abc"}' } }, 400),
    );
    const error = await guardedFetch("https://oauth2.googleapis.com/token", { fetchImpl })
      .then(() => null)
      .catch((caught: unknown) => caught as Error);
    expect(error!.message).not.toContain("BEGIN PRIVATE KEY");
  });

  it("falls back to status text when the body carries no message", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response("", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(
      guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", { fetchImpl }),
    ).rejects.toThrow("502 Bad Gateway");
  });

  it("passes the caller's abort signal through", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return jsonResponse({});
    });
    await expect(
      guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", {
        fetchImpl,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("redirects", () => {
  it("refuses to follow them, so a 302 cannot reach an unchecked host", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}));
    await guardedFetch("https://analyticsdata.googleapis.com/v1beta/x", { fetchImpl });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).redirect).toBe("error");
  });
});
