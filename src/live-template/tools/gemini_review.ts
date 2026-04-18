import { tool } from "@opencode-ai/plugin"
import { runReviewTool } from "../runtime/bridge"

export default tool({
  description:
    "Ask Gemini CLI to review the current implementation or answer for correctness, risk, and plan fidelity, save the full structured artifacts to disk, and return only a compact review synthesis for internal use.",
  args: {
    request: tool.schema.string().describe("The user request that this work is meant to satisfy."),
    model: tool.schema
      .string()
      .optional()
      .describe("Optional Gemini model override for this review call. Omit this unless the user explicitly requested a Gemini model change in the current turn."),
    implementation_summary: tool.schema
      .string()
      .describe("What OpenCode changed, discovered, or plans to answer."),
    changed_files: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Files changed or closely involved in the work. Keep paths inside the current workspace root."),
    compact_plan: tool.schema
      .string()
      .optional()
      .describe("Optional compact plan summary when the latest plan is not already available from the live session artifacts."),
    contradictions: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Optional contradiction summaries from the latest review cycle when asking Gemini to re-review or resolve conflicts."),
    routing_context: tool.schema
      .string()
      .optional()
      .describe("Optional routing or escalation context when the current turn should be reviewed more aggressively."),
    tests_run: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Tests or validation commands already run."),
    open_questions: tool.schema
      .string()
      .optional()
      .describe("Any remaining ambiguity or known caveats to include in the review."),
  },
  async execute(args, context) {
    return runReviewTool({
      request: args.request,
      model: args.model,
      implementationSummary: args.implementation_summary,
      changedFiles: args.changed_files,
      compactPlan: args.compact_plan,
      contradictions: args.contradictions,
      routingContext: args.routing_context,
      testsRun: args.tests_run,
      openQuestions: args.open_questions,
      context,
    })
  },
})
