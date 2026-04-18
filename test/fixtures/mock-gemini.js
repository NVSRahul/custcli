#!/usr/bin/env node

const args = process.argv.slice(2)
const promptIndex = args.lastIndexOf("-p")
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : ""

const isReviewPrompt = /You are reviewing work performed by OpenCode/i.test(prompt)

const response = isReviewPrompt
  ? {
      verdict: "approved",
      summary: "Mock review approved the worker result.",
      findings: [
        {
          id: "finding-1",
          severity: "low",
          summary: "Mock review found no blocking issues.",
          details: "The mock worker output matched the compact evidence expectations.",
          contradictionTarget: "step-1",
          evidence: "Mock worker executed successfully.",
          replanScope: [],
          verificationTarget: "Worker reports completion without errors.",
        },
      ],
      risks: [],
      follow_up_steps: [],
      tests: ["Mock review observed the worker output."],
    }
  : {
      goal: "Build the requested feature with the mock planner",
      workspace_summary: "Mock planner inspected the workspace and prepared a deterministic execution artifact.",
      reasoning_summary: "Use the planner result as the single source of truth for the worker prompt.",
      decision_log: [
        "Captured the workspace goal.",
        "Prepared a single high-signal execution step for the worker.",
      ],
      findings: ["Mock planner executed successfully."],
      assumptions: ["OpenCode worker is available through the configured command spec."],
      risks: ["This is a mock planner response for automated testing."],
      execution_steps: [
        {
          id: "step-1",
          title: "Implement the requested work",
          goal: "Implement the requested work in the current workspace.",
          description: "Use the worker to apply the requested change in the current workspace.",
          opencodePrompt: `Implement the requested work for this prompt: ${prompt.slice(0, 160)}`,
          dependsOn: [],
          doneWhen: ["Worker reports completion without errors."],
          claims: ["The requested work is implemented in the current workspace."],
          expectedEvidence: ["Worker reports completion without errors."],
          writeScope: ["<workspace>"],
          verificationRules: ["Confirm the worker reports completion without errors."],
          fallback: ["Re-plan if the worker reports a workspace mismatch."],
        },
      ],
      replan_triggers: ["Worker reports a codebase mismatch."],
      success_criteria: ["Worker completes successfully."],
    }

process.stdout.write(
  JSON.stringify({
    session_id: "gemini-mock-session",
    response: JSON.stringify(response),
  }),
)
