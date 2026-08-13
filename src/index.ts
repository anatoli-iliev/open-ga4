import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: "ga4",
  name: "GA4 Analytics",
  description: "Add GA4 Analytics tools to OpenClaw.",
  tools: (tool) => [
    tool({
      name: "echo",
      description: "Echo input text.",
      parameters: Type.Object({
        input: Type.String({ description: "Text to echo." }),
      }),
      execute: async ({ input }) => ({ input }),
    }),
  ],
});
