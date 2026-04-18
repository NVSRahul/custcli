import test from "node:test"
import assert from "node:assert/strict"
import { createEvidenceGraph, compactEvidenceGraph } from "../src/lib/evidence.js"

test("createEvidenceGraph builds structured evidence from worker output", () => {
  const graph = createEvidenceGraph({
    plan: {
      goal: "Ship feature",
      executionSteps: [
        {
          id: "step-1",
          title: "Update code",
          goal: "Update the code",
          claims: ["The feature behavior is updated."],
          expectedEvidence: ["Worker reports completion without errors."],
          writeScope: ["src/app.js"],
          verificationRules: ["Validate the updated behavior before concluding."],
          fallback: ["Re-plan if the repository contradicts the plan."],
        },
      ],
    },
    worker: {
      status: "completed",
      code: 0,
      ok: true,
      finalText: "Mock worker executed. Worker reports completion without errors. Updated behavior was validated.",
      changedFiles: ["src/app.js"],
      errors: [],
      events: [{ type: "text" }, { type: "session.status" }],
    },
    passNumber: 1,
    plannerSessionId: "planner-1",
    request: "Ship feature",
  })

  assert.equal(graph.stepEvidence.length, 1)
  assert.equal(graph.stepEvidence[0].verificationStatus, "verified")
  assert.equal(graph.verifiedStepCount, 1)
  assert.equal(graph.changedFiles[0], "src/app.js")

  const compact = compactEvidenceGraph(graph)
  assert.equal(compact.stepEvidence[0].verificationStatus, "verified")
})

test("createEvidenceGraph marks blocked steps when worker fails", () => {
  const graph = createEvidenceGraph({
    plan: {
      goal: "Ship feature",
      executionSteps: [
        {
          id: "step-1",
          title: "Update code",
          goal: "Update the code",
          claims: ["The feature behavior is updated."],
          expectedEvidence: ["Worker reports completion without errors."],
          writeScope: ["src/app.js"],
          verificationRules: ["Validate the updated behavior before concluding."],
          fallback: ["Re-plan if the repository contradicts the plan."],
        },
      ],
    },
    worker: {
      status: "failed",
      code: 1,
      ok: false,
      finalText: "Worker failed before validation.",
      changedFiles: [],
      errors: [{ message: "Command failed." }],
      events: [{ type: "error" }],
    },
    passNumber: 1,
    plannerSessionId: "planner-1",
    request: "Ship feature",
  })

  assert.equal(graph.blockedStepCount, 1)
  assert.equal(graph.stepEvidence[0].verificationStatus, "blocked")
})
