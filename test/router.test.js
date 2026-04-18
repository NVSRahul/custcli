import test from "node:test"
import assert from "node:assert/strict"
import { computeRoutingDecision } from "../src/lib/router.js"

test("computeRoutingDecision escalates review intensity when contradictions or risk are present", () => {
  const routing = computeRoutingDecision({
    userPrompt: "Implement a fairly involved feature with multiple steps and validation requirements.",
    plan: {
      executionSteps: [{}, {}, {}],
      risks: ["Regression risk", "Validation uncertainty"],
      assumptions: ["A", "B", "C"],
    },
    reviewHistory: [{ verdict: "changes_requested" }],
    contradictions: [{ id: "c-1" }],
    plannerModel: "gemini-3.1-pro-preview",
    workerModel: "mini-model",
  })

  assert.equal(routing.reasoning.reviewIntensity, "high")
  assert.equal(routing.reasoning.loopBudget, 2)
  assert.equal(routing.execution.strategy, "guided")
})

test("computeRoutingDecision stays light for straightforward prompts", () => {
  const routing = computeRoutingDecision({
    userPrompt: "Fix typo",
    plan: {
      executionSteps: [{}],
      risks: [],
      assumptions: [],
    },
    reviewHistory: [],
    contradictions: [],
  })

  assert.equal(routing.reasoning.intensity, "baseline")
  assert.equal(routing.reasoning.loopBudget, 1)
})
