import { tool } from "@opencode-ai/plugin"
import { runRawGeminiTool } from "../runtime/bridge"

export default tool({
  description:
    "Run Gemini CLI directly with explicit arguments while keeping the live session linked to Gemini's session history when possible. Use Gemini's real CLI flags only: headless mode uses -p/--prompt, and custcli will reject unsafe raw flags like --worktree.",
  args: {
    argv: tool.schema
      .array(tool.schema.string())
      .describe("Arguments to pass after the Gemini executable. Do not include the executable itself. Use real Gemini CLI flags only; for headless prompts use -p/--prompt, not invented flags like --verbose."),
    model: tool.schema
      .string()
      .optional()
      .describe("Optional Gemini model override for this raw command. Omit this unless the user explicitly requested a Gemini model change in the current turn."),
    stdin: tool.schema.string().optional().describe("Optional stdin text to send to Gemini."),
    reuse_session: tool.schema
      .boolean()
      .optional()
      .describe("Whether to resume the current Gemini session automatically when possible."),
  },
  async execute(args, context) {
    return runRawGeminiTool({
      argv: args.argv,
      model: args.model,
      stdin: args.stdin,
      reuseSession: args.reuse_session !== false,
      context,
    })
  },
})
