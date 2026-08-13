import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import plugin, { TOOL_NAMES } from "./index.js";
import type { Ga4Tool } from "./types.js";

/**
 * The SDK does not ship its test helpers (they are excluded from the published
 * package), so registrations are captured with a local stub.
 */
function register(overrides: Partial<OpenClawPluginApi> = {}): Ga4Tool[] {
  const tools: Ga4Tool[] = [];
  plugin.register?.({
    registrationMode: "full",
    pluginConfig: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: (tool: unknown) => {
      tools.push(tool as Ga4Tool);
    },
    ...overrides,
  } as unknown as OpenClawPluginApi);
  return tools;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "../openclaw.plugin.json");

describe("registration", () => {
  it("registers exactly the six documented tools", () => {
    expect(register().map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  it("marks every result as network-sourced, because rows come from site visitors", () => {
    for (const tool of register()) {
      expect(tool.resultContentSource, tool.name).toBe("network");
    }
  });

  it("gives every tool a label and a description", () => {
    for (const tool of register()) {
      expect(tool.label, tool.name).toBeTruthy();
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
    }
  });

  it("gives every tool a TypeBox object parameter schema", () => {
    for (const tool of register()) {
      expect((tool.parameters as { type?: string }).type, tool.name).toBe("object");
    }
  });

  it("still registers tools during tool discovery, or they vanish from the catalog", () => {
    expect(register({ registrationMode: "tool-discovery" } as never)).toHaveLength(
      TOOL_NAMES.length,
    );
  });

  it("reads no configuration during a non-registering pass", () => {
    expect(register({ registrationMode: "config-validation" } as never)).toHaveLength(0);
  });

  it("warns rather than throwing on an unusable redaction pattern", () => {
    const warn = vi.fn();
    const tools = register({
      pluginConfig: { privacy: { extraRedactionPatterns: ["(unclosed"] } },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    } as never);
    expect(tools).toHaveLength(TOOL_NAMES.length);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("extraRedactionPatterns"));
  });
});

describe("tool descriptions", () => {
  /**
   * Google's own Analytics MCP server ships a `run_report` description that
   * directs the model to four tools it never registers. This makes that class
   * of bug a test failure.
   */
  it("never names a ga4_ tool that does not exist", () => {
    const tools = register();
    const registered = new Set(tools.map((tool) => tool.name));
    const offenders: string[] = [];

    for (const tool of tools) {
      const text = `${tool.description} ${tool.promptSnippet ?? ""}`;
      for (const match of text.matchAll(/\bga4_[a-z_]+\b/g)) {
        if (!registered.has(match[0])) {
          offenders.push(`${tool.name} refers to ${match[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("says when to use each tool, not just what it is", () => {
    for (const tool of register()) {
      expect(tool.description, tool.name).toMatch(/use this|run this/i);
    }
  });

  it("avoids superlatives, which do not help a model route", () => {
    for (const tool of register()) {
      expect(tool.description, tool.name).not.toMatch(/\b(best|powerful|comprehensive|ultimate)\b/i);
    }
  });
});

describe("manifest", () => {
  it("declares the same tools the code registers", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      contracts?: { tools?: string[] };
    };
    expect(manifest.contracts?.tools).toEqual([...TOOL_NAMES]);
  });

  it("uses the plugin id the entry declares", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { id?: string };
    expect(manifest.id).toBe(plugin.id);
  });

  it("keeps its description in step with the entry", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { description?: string };
    expect(manifest.description).toBe(plugin.description);
  });
});
