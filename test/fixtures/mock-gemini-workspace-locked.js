#!/usr/bin/env node

const args = process.argv.slice(2)
const includeDirectoriesIndex = args.indexOf("--include-directories")
const sandboxEnabled = args.includes("--sandbox")
const promptIndex = args.lastIndexOf("-p")
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : ""

if (includeDirectoriesIndex === -1 || !args[includeDirectoriesIndex + 1]) {
  process.stderr.write("Missing required --include-directories workspace lock.\n")
  process.exit(1)
}

if (!sandboxEnabled) {
  process.stderr.write("Missing required --sandbox flag.\n")
  process.exit(1)
}

const workspaceRoot = args[includeDirectoriesIndex + 1]

process.stdout.write(
  JSON.stringify({
    session_id: "gemini-workspace-locked-session",
    response: JSON.stringify({
      goal: "Review the workspace with locked Gemini scope",
      workspace_summary: `Gemini stayed inside ${workspaceRoot}`,
      reasoning_summary: `Workspace lock verified for prompt: ${prompt.slice(0, 80)}`,
      decision_log: ["Confirmed that custcli passed workspace lock flags to Gemini."],
      findings: ["Gemini was launched with a workspace include-directory and sandbox flag."],
      assumptions: [],
      risks: [],
      execution_steps: [
        {
          id: "step-1",
          title: "Review the workspace safely",
          description: "Inspect the current workspace without escaping its directory scope.",
          opencodePrompt: "Review the current workspace safely.",
          dependsOn: [],
          doneWhen: ["The workspace review is complete."],
        },
      ],
      replan_triggers: [],
      success_criteria: ["Gemini stays scoped to the current workspace."],
    }),
  }),
)
