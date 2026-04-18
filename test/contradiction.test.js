import test from "node:test"
import assert from "node:assert/strict"
import { buildContradictions, scopePlanByContradictions } from "../src/lib/contradiction.js"

test("buildContradictions preserves typed reviewer targets and scope", () => {
  const contradictions = buildContradictions({
    review: {
      findings: ["Missing verification."],
      findingDetails: [
        {
          id: "finding-1",
          severity: "high",
          summary: "Missing verification.",
          contradictionTarget: "step-2",
          evidence: "No tests were run.",
          replanScope: ["step-2", "src/app.js"],
          verificationTarget: "Run verification for step-2.",
        },
      ],
      risks: ["Regression risk remains."],
      summary: "Needs follow-up.",
    },
    evidenceGraph: {
      summary: "Worker changed src/app.js without verification.",
      stepEvidence: [
        {
          stepId: "step-1",
          writeScope: ["src/setup.js"],
          verificationRules: ["Keep setup intact."],
          expectedEvidence: ["Setup stays intact."],
          observedEvidence: ["changed:src/setup.js"],
          verificationStatus: "verified",
        },
        {
          stepId: "step-2",
          writeScope: ["src/app.js"],
          verificationRules: ["Run verification for step-2."],
          expectedEvidence: ["Tests pass for src/app.js."],
          observedEvidence: ["changed:src/app.js"],
          verificationStatus: "missing",
        },
      ],
    },
    passNumber: 1,
  })

  assert.equal(contradictions.length, 2)
  assert.equal(contradictions[0].contradictionTarget, "step-2")
  assert.equal(contradictions[0].replanScope[1], "src/app.js")
  assert.equal(contradictions[1].source, "review:risk")
})

test("scopePlanByContradictions focuses only the contradicted slice", () => {
  const scope = scopePlanByContradictions({
    plan: {
      executionSteps: [
        { id: "step-1", title: "One", writeScope: ["src/setup.js"] },
        { id: "step-2", title: "Two", writeScope: ["src/app.js"] },
      ],
    },
    contradictions: [
      {
        contradictionTarget: "step-2",
        replanScope: ["step-2", "src/app.js"],
      },
    ],
  })

  assert.equal(scope.affectedSteps.length, 1)
  assert.equal(scope.affectedSteps[0].id, "step-2")
  assert.equal(scope.preservedSteps[0].id, "step-1")
})
