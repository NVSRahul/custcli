import { tool } from "@opencode-ai/plugin"
import { runPlanningTool } from "../runtime/bridge"

export default tool({
  description:
    "Ask Gemini CLI to analyze the current request as the external planner, save the full artifacts to disk, and return only a compact planning synthesis for internal use.",
  args: {
    request: tool.schema.string().describe("The current user request or subtask that needs planning."),
    model: tool.schema
      .string()
      .optional()
      .describe("Optional Gemini model override for this planning call. Omit this unless the user explicitly requested a Gemini model change in the current turn."),
    workspace_context: tool.schema
      .string()
      .optional()
      .describe("Relevant workspace findings, changed files, prior plan status, or ambiguity to include in the planner prompt. Keep referenced paths inside the current workspace root, and do not paste raw OpenCode env lines that incorrectly claim the workspace root is '/'."),
  },
  async execute(args, context) {
    return runPlanningTool({
      request: args.request,
      model: args.model,
      workspaceContext: args.workspace_context,
      context,
    })
  },
})
