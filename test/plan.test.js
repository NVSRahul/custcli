import test from "node:test"
import assert from "node:assert/strict"
import { extractPlan, machineCheckPlan } from "../src/lib/plan.js"

test("extractPlan normalizes strict planner JSON into typed machine-checkable steps", () => {
  const raw = JSON.stringify({
    goal: "Ship feature",
    workspace_summary: "Repo summary",
    reasoning_summary: "Reasoning summary",
    decision_log: ["One", "Two"],
    plan_claims: ["Feature ships cleanly."],
    execution_steps: [
      {
        id: "a",
        title: "Do the thing",
        goal: "Update the implementation",
        description: "Description",
        opencodePrompt: "Prompt",
        dependsOn: ["b"],
        doneWhen: ["done"],
        claims: ["The feature behavior is updated."],
        expectedEvidence: ["Tests or worker output confirm the update."],
        writeScope: ["src/app.js"],
        verificationRules: ["Validate the updated behavior before concluding."],
        fallback: ["Re-plan if the repository contradicts the plan."],
      },
      {
        id: "b",
        title: "Verify",
        description: "Check it",
        opencodePrompt: "Verify it",
        dependsOn: [],
        doneWhen: ["verified"],
      },
    ],
    success_criteria: ["green"],
  })

  const plan = extractPlan(raw)
  assert.equal(plan.goal, "Ship feature")
  assert.equal(plan.workspaceSummary, "Repo summary")
  assert.equal(plan.executionSteps[0].id, "a")
  assert.equal(plan.executionSteps[0].dependsOn[0], "b")
  assert.equal(plan.executionSteps[0].claims[0], "The feature behavior is updated.")
  assert.equal(plan.executionSteps[0].writeScope[0], "src/app.js")
  assert.equal(plan.planClaims[0], "Feature ships cleanly.")
  assert.equal(plan.machineCheck.readyForExecution, true)
})

test("machineCheckPlan repairs duplicate ids and invalid dependencies during normalization", () => {
  const plan = extractPlan(
    JSON.stringify({
      execution_steps: [
        {
          id: "step",
          title: "One",
          opencodePrompt: "Do one",
          dependsOn: ["missing", "step"],
        },
        {
          id: "step",
          title: "Two",
          opencodePrompt: "Do two",
        },
      ],
    }),
  )

  assert.equal(plan.executionSteps[0].id, "step")
  assert.equal(plan.executionSteps[1].id, "step-2")
  assert.deepEqual(plan.executionSteps[0].dependsOn, [])

  const check = machineCheckPlan(plan)
  assert.equal(check.readyForExecution, true)
})

test("extractPlan falls back for non-json content with typed defaults", () => {
  const plan = extractPlan("Think carefully and then implement the requested work.")
  assert.equal(plan.executionSteps.length, 1)
  assert.match(plan.reasoningSummary, /implement/i)
  assert.match(plan.risks[0], /non-JSON/i)
  assert.equal(plan.executionSteps[0].writeScope[0], "<workspace>")
  assert.equal(plan.machineCheck.readyForExecution, true)
})
