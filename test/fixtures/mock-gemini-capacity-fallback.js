#!/usr/bin/env node

const args = process.argv.slice(2)
const promptIndex = args.lastIndexOf("-p")
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : ""
const modelIndex = args.lastIndexOf("-m")
const model = modelIndex >= 0 ? args[modelIndex + 1] : null

if (model === "gemini-3.1-pro-preview") {
  process.stderr.write("MODEL_CAPACITY_EXHAUSTED: No capacity available for model gemini-3.1-pro-preview on the server\n")
  process.exit(1)
}

const response = {
  goal: "Review the codebase with the capacity fallback planner",
  workspace_summary: "The planner retried without a pinned model.",
  reasoning_summary: "Pinned pro model capacity was exhausted, so planning fell back successfully.",
  decision_log: ["Retried planning after server capacity was exhausted for the pinned model."],
  findings: ["Capacity fallback planner executed successfully."],
  assumptions: [],
  risks: [],
  execution_steps: [
    {
      id: "step-1",
      title: "Review the codebase",
      description: "Inspect the repository and report issues.",
      opencodePrompt: `Review the codebase for this prompt: ${prompt.slice(0, 120)}`,
      dependsOn: [],
      doneWhen: ["Review is complete."],
    },
  ],
  replan_triggers: [],
  success_criteria: ["A plan is returned."],
}

process.stdout.write(
  JSON.stringify({
    session_id: "gemini-capacity-fallback-session",
    response: JSON.stringify(response),
  }),
)
