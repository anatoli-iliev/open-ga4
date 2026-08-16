export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const COMMANDS = ["doctor", "report", "compare", "live", "query", "fields", "properties"] as const;

/**
 * Names that must never become flags.
 *
 * These four settings weaken the privacy defaults. A flag can be set by the
 * model, and dimension values are authored by site visitors, so a page title is
 * a channel for talking an agent into passing one. They are environment
 * variables so that a person sets them.
 */
export const FORBIDDEN_FLAGS = [
  "redact", "no-redact",
  "allow-user-dimensions", "allow-user-identifying-dimensions",
  "property-allowlist",
  "audit-log",
] as const;

const KNOWN_FLAGS: Record<string, readonly string[]> = {
  doctor: ["json"],
  report: ["property", "range", "start", "end", "limit", "filter", "json"],
  compare: ["property", "range", "against", "limit", "filter", "json"],
  live: ["property", "limit", "json"],
  query: ["property", "dimensions", "metrics", "range", "start", "end", "limit", "filter", "sort", "json"],
  fields: ["property", "kind", "json"],
  properties: ["json"],
};

export type ParsedArgs =
  | { kind: "help"; command?: string }
  | { kind: "version" }
  | { kind: "command"; command: string; positional: string[]; flags: Record<string, string | boolean> };

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] === "--version" || argv[0] === "-V") return { kind: "version" };

  const command = argv[0]!;
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(
      `unknown command ${JSON.stringify(command)}. Valid commands are: ${COMMANDS.join(", ")}.`,
    );
  }

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const allowed = KNOWN_FLAGS[command]!;
  let literal = false;

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (literal) { positional.push(token); continue; }
    if (token === "--") { literal = true; continue; }
    if (token === "--help" || token === "-h") return { kind: "help", command };

    if (!token.startsWith("--")) { positional.push(normalizeId(token)); continue; }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);

    if ((FORBIDDEN_FLAGS as readonly string[]).includes(name)) {
      throw new UsageError(
        `--${name} is not a flag. It changes a privacy default, so it is set by a person ` +
          `through an environment variable, not by an agent on a command line. ` +
          `See the Privacy section of SKILL.md.`,
      );
    }
    if (!allowed.includes(name)) {
      throw new UsageError(
        `unknown option --${name} for ${command}. Valid options are: ` +
          `${allowed.map((f) => `--${f}`).join(", ")}.`,
      );
    }

    if (eq !== -1) { flags[name] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { flags[name] = true; continue; }
    flags[name] = next;
    i += 1;
  }

  return { kind: "command", command, positional, flags };
}

/** Preset ids are snake_case; a model writes hyphens more often than underscores. */
function normalizeId(value: string): string {
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(value) ? value.replaceAll("-", "_") : value;
}
