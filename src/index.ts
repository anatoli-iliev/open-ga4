import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { configSchema, resolveConfig, type Ga4PluginConfig } from "./config.js";
import { diagnose } from "./ga4/errors.js";
import { redactText } from "./privacy/redact.js";
import { createRuntime, type Ga4Runtime } from "./runtime.js";
import { diagnoseTool, fieldsTool } from "./tools/discovery.js";
import { compareTool, queryTool, realtimeTool, reportTool } from "./tools/reports.js";
import type { Ga4Tool } from "./types.js";

/**
 * Plugin entry.
 *
 * Uses `definePluginEntry` rather than `defineToolPlugin` for one specific
 * reason: every tool here returns content that originated with anonymous
 * website visitors, and only the full registration API can mark a result as
 * network-sourced. See docs/DESIGN.md, decisions D1 and D6.
 */

export const TOOL_NAMES = [
  "ga4_report",
  "ga4_compare",
  "ga4_realtime",
  "ga4_query",
  "ga4_fields",
  "ga4_diagnose",
] as const;

/** A tool before it is adapted to the host's calling convention. */
export type Ga4ToolSpec = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute(params: never, signal?: AbortSignal): Promise<{ markdown: string; details: unknown }>;
};

export function buildToolSpecs(runtime: Ga4Runtime): Ga4ToolSpec[] {
  return [
    reportTool(runtime),
    compareTool(runtime),
    realtimeTool(runtime),
    queryTool(runtime),
    fieldsTool(runtime),
    diagnoseTool(runtime),
  ] as unknown as Ga4ToolSpec[];
}

/**
 * Wrap a tool spec in the host's tool contract.
 *
 * `AgentToolResult` has no error channel — it is exactly
 * `{ content, details, progress?, terminate? }` — so a failure is a thrown
 * error, never a result that looks like data. That is deliberate: it means a
 * result the model receives is always a truthful description of a query that
 * actually ran.
 */
export function toAgentTool(spec: Ga4ToolSpec, runtime: Ga4Runtime): Ga4Tool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    ...(spec.promptSnippet ? { promptSnippet: spec.promptSnippet } : {}),
    parameters: spec.parameters,
    resultContentSource: "network",
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      try {
        const result = await spec.execute(params as never, signal);
        return textResult(result.markdown, result.details);
      } catch (error) {
        const named = diagnose(error, { principal: runtime.principal() });
        throw new Error(redactText(named.toString()));
      }
    },
  } as Ga4Tool;
}

// Annotated with the exported supertype: `definePluginEntry` returns a type the
// SDK subpath does not export, which makes `declaration: true` builds emit a
// non-portable reference into openclaw's internals (TS2742).
const ga4Plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "ga4",
  name: "GA4 Analytics",
  description:
    "Read-only, privacy-respecting access to Google Analytics 4: reports, comparisons, realtime, " +
    "and field discovery.",
  configSchema: () => buildJsonPluginConfigSchema(configSchema as never),
  register(api: OpenClawPluginApi) {
    // Discovery passes must not read credentials or open a client. Tools still
    // have to register during tool discovery or they go missing from the
    // catalog; everything they need is built lazily on first call.
    const mode = api.registrationMode;
    if (mode !== "full" && mode !== "tool-discovery") {
      return;
    }

    const config = resolveConfig(api.pluginConfig as Ga4PluginConfig | undefined, (message) => {
      api.logger.warn(message);
    });
    const runtime = createRuntime({ config });

    for (const spec of buildToolSpecs(runtime)) {
      api.registerTool(toAgentTool(spec, runtime));
    }
  },
});

export default ga4Plugin;
