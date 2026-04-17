#!/usr/bin/env node

const args = process.argv.slice(2)
const promptIndex = args.lastIndexOf("-p")
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : ""
const modelIndex = args.lastIndexOf("-m")
const model = modelIndex >= 0 ? args[modelIndex + 1] : null

if (model === "gemini-2.0-flash") {
  process.stderr.write("ModelNotFoundError: Requested entity was not found.\n")
  process.exit(1)
}

const response = {
  goal: "Review the codebase with the fallback planner",
  workspace_summary: "The fallback planner completed successfully.",
  reasoning_summary: "A bad override model was ignored and planning continued with the default behavior.",
  decision_log: ["Retried planning after the requested model override was unavailable."],
  findings: ["Fallback planner executed successfully."],
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
    session_id: "gemini-fallback-session",
    response: JSON.stringify(response),
  }),
)
