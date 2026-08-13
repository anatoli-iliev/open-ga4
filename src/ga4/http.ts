import { redactText } from "../privacy/redact.js";

/**
 * The complete set of hosts this plugin is permitted to contact.
 *
 * Every outbound request goes through {@link guardedFetch}, which rejects any
 * URL whose host is not on this list. That turns "we only talk to Google" from
 * a promise in a README into an invariant with a test behind it. Adding a host
 * here is a visible, reviewable diff.
 */
export const ALLOWED_HOSTS: readonly string[] = [
  "oauth2.googleapis.com",
  "analyticsdata.googleapis.com",
  "analyticsadmin.googleapis.com",
];

export class EgressBlockedError extends Error {
  constructor(readonly host: string) {
    super(
      `Blocked a request to ${host}. This plugin may only contact ${ALLOWED_HOSTS.join(", ")}.`,
    );
    this.name = "EgressBlockedError";
  }
}

export class Ga4HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "Ga4HttpError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GuardedFetchOptions = {
  method?: "GET" | "POST";
  accessToken?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra headers. Never used for credentials — those go through accessToken. */
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function assertAllowedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressBlockedError(url);
  }
  if (parsed.protocol !== "https:") {
    throw new EgressBlockedError(`${parsed.protocol}//${parsed.host}`);
  }
  if (!ALLOWED_HOSTS.includes(parsed.host)) {
    throw new EgressBlockedError(parsed.host);
  }
  return parsed;
}

/**
 * Perform an HTTPS request against an allowlisted Google host.
 *
 * Errors carry the parsed response body so the error taxonomy can turn a
 * Google error into an actionable sentence, and every message is run through
 * credential redaction on the way out.
 */
export async function guardedFetch(
  url: string,
  options: GuardedFetchOptions = {},
): Promise<unknown> {
  assertAllowedUrl(url);

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const headers: Record<string, string> = {
    accept: "application/json",
    ...options.headers,
  };
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetchImpl(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal,
  });

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }

  if (!response.ok) {
    throw new Ga4HttpError(response.status, parsed, redactText(messageFrom(parsed, response)));
  }

  return parsed;
}

function messageFrom(body: unknown, response: Response): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") {
      const description = (body as { error_description?: unknown }).error_description;
      return typeof description === "string" ? `${error}: ${description}` : error;
    }
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return `${response.status} ${response.statusText}`.trim();
}
