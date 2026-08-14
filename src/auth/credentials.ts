import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ServiceAccount } from "./jwt.js";

/**
 * Credential discovery.
 *
 * Deliberately mirrors Google's own Application Default Credentials order so
 * that anyone who already authenticated for another Google tool, or who is
 * migrating from a GA4 skill that used `GOOGLE_APPLICATION_CREDENTIALS`, is
 * already set up and has nothing to configure.
 */

export type CredentialKind = "service_account" | "authorized_user";

export type Credential =
  | {
      kind: "service_account";
      account: ServiceAccount;
      /** Where it came from, for `ga4_diagnose`. Never contains key material. */
      source: string;
    }
  | {
      kind: "authorized_user";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      quotaProjectId?: string;
      source: string;
    };

/** One place the loader looked, and what it found. Drives the diagnose output. */
export type CredentialProbe = {
  label: string;
  path: string;
  status: "used" | "absent" | "unreadable" | "invalid";
  detail?: string;
};

export type CredentialResolution =
  | { ok: true; credential: Credential; probes: CredentialProbe[] }
  | { ok: false; probes: CredentialProbe[] };

export type CredentialEnvironment = {
  /** `plugins.entries.ga4.config.credentials`, already resolved to a string. */
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFileImpl?: (filePath: string) => Promise<string>;
};

/** Where gcloud writes `application-default login` output on each platform. */
export function applicationDefaultCredentialsPath(home: string, platform = process.platform): string {
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "gcloud", "application_default_credentials.json");
  }
  return path.join(home, ".config", "gcloud", "application_default_credentials.json");
}

function expandHome(filePath: string, home: string): string {
  if (filePath === "~") {
    return home;
  }
  if (filePath.startsWith("~/")) {
    return path.join(home, filePath.slice(2));
  }
  return filePath;
}

/**
 * Parse a Google credential file.
 *
 * Both shapes Google emits are accepted: a service-account key (what you
 * download from IAM) and an authorized-user file (what
 * `gcloud auth application-default login` writes).
 */
export function parseCredentialFile(contents: string, source: string): Credential {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contents) as Record<string, unknown>;
  } catch {
    throw new Error("file is not valid JSON");
  }

  const type = typeof parsed.type === "string" ? parsed.type : undefined;

  if (type === "authorized_user") {
    const clientId = stringField(parsed, "client_id");
    const clientSecret = stringField(parsed, "client_secret");
    const refreshToken = stringField(parsed, "refresh_token");
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("authorized-user file is missing client_id, client_secret, or refresh_token");
    }
    return {
      kind: "authorized_user",
      clientId,
      clientSecret,
      refreshToken,
      quotaProjectId: stringField(parsed, "quota_project_id"),
      source,
    };
  }

  if (type === "external_account" || type === "impersonated_service_account") {
    throw new Error(
      `credential type "${type}" is not supported; use a service-account key or gcloud application-default credentials`,
    );
  }

  const clientEmail = stringField(parsed, "client_email");
  const privateKey = stringField(parsed, "private_key");
  if (!clientEmail || !privateKey) {
    throw new Error(
      "service-account file is missing client_email or private_key; download the key file again from Google Cloud",
    );
  }

  return {
    kind: "service_account",
    account: {
      clientEmail,
      // Key files store the PEM with literal "\n" when they have been passed
      // through an environment variable or a shell.
      privateKey: privateKey.replace(/\\n/g, "\n"),
      tokenUri: stringField(parsed, "token_uri"),
    },
    source,
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Walk the credential sources in order and return the first usable one,
 * along with a record of everything that was tried.
 */
export async function resolveCredentials(
  options: CredentialEnvironment = {},
): Promise<CredentialResolution> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const read = options.readFileImpl ?? ((filePath: string) => readFile(filePath, "utf8"));

  const candidates: Array<{ label: string; path: string } | undefined> = [
    options.configuredPath
      ? { label: "plugin config (credentials)", path: expandHome(options.configuredPath, home) }
      : undefined,
    env.GOOGLE_APPLICATION_CREDENTIALS
      ? {
          label: "GOOGLE_APPLICATION_CREDENTIALS",
          path: expandHome(env.GOOGLE_APPLICATION_CREDENTIALS, home),
        }
      : undefined,
    { label: "gcloud application-default credentials", path: applicationDefaultCredentialsPath(home) },
  ];

  const probes: CredentialProbe[] = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    let contents: string;
    try {
      contents = await read(candidate.path);
    } catch (error) {
      probes.push({
        ...candidate,
        status: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable",
        detail: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : describe(error),
      });
      continue;
    }
    try {
      const credential = parseCredentialFile(contents, candidate.label);
      probes.push({ ...candidate, status: "used" });
      return { ok: true, credential, probes };
    } catch (error) {
      probes.push({ ...candidate, status: "invalid", detail: describe(error) });
    }
  }

  return { ok: false, probes };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
