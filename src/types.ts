import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

/**
 * A tool definition widened with fields that exist on newer hosts.
 *
 * `resultContentSource` marks a tool's output as externally controlled
 * content. It landed in OpenClaw 2026.8.x; the newest *released* host at the
 * time of writing is 2026.7.1-2, where `AgentTool` does not declare it and
 * TypeScript's excess-property check rejects it.
 *
 * We still emit the field. It is inert on hosts that do not read it and
 * honoured on hosts that do, so the plugin gets the stronger provenance
 * marking automatically as users upgrade, without a second release or a
 * version check at runtime. `outputSchema` is in the same position.
 *
 * Verified by grepping the installed host: `resultContentSource` appears zero
 * times in openclaw@2026.7.1-2 and 105 times in 2026.8.1-beta.1.
 */
export type Ga4Tool = AnyAgentTool & {
  readonly resultContentSource?: "network";
  readonly outputSchema?: unknown;
  readonly promptSnippet?: string;
};
