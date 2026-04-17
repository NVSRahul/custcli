import test from "node:test"
import assert from "node:assert/strict"
import { extractPlan } from "../src/lib/plan.js"

test("extractPlan normalizes strict planner JSON", () => {
  const raw = JSON.stringify({
    goal: "Ship feature",
    workspace_summary: "Repo summary",
    reasoning_summary: "Reasoning summary",
    decision_log: ["One", "Two"],
    execution_steps: [
      {
        id: "a",
        title: "Do the thing",
        description: "Description",
        opencodePrompt: "Prompt",
        dependsOn: ["b"],
        doneWhen: ["done"],
      },
    ],
    success_criteria: ["green"],
  })

  const plan = extractPlan(raw)
  assert.equal(plan.goal, "Ship feature")
  assert.equal(plan.workspaceSummary, "Repo summary")
  assert.equal(plan.executionSteps[0].id, "a")
  assert.equal(plan.executionSteps[0].dependsOn[0], "b")
  assert.equal(plan.successCriteria[0], "green")
})

test("extractPlan falls back for non-json content", () => {
  const plan = extractPlan("Think carefully and then implement the requested work.")
  assert.equal(plan.executionSteps.length, 1)
  assert.match(plan.reasoningSummary, /implement/i)
  assert.match(plan.risks[0], /non-JSON/i)
})
