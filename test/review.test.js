import test from "node:test"
import assert from "node:assert/strict"
import { extractReview } from "../src/lib/review.js"

test("extractReview normalizes typed findings", () => {
  const review = extractReview(
    JSON.stringify({
      verdict: "changes_requested",
      summary: "Needs one follow-up.",
      findings: [
        {
          id: "finding-1",
          severity: "high",
          summary: "Missing verification.",
          details: "The implementation did not prove the main claim.",
          contradictionTarget: "step-2",
          evidence: "No tests were run.",
          replanScope: ["step-2", "src/app.js"],
          verificationTarget: "Run verification for step-2.",
        },
      ],
      risks: ["Regression risk remains."],
      follow_up_steps: ["Re-run verification."],
      tests: ["No tests executed."],
    }),
  )

  assert.equal(review.verdict, "changes_requested")
  assert.equal(review.findings[0], "Missing verification.")
  assert.equal(review.findingDetails[0].severity, "high")
  assert.equal(review.findingDetails[0].contradictionTarget, "step-2")
  assert.equal(review.findingDetails[0].replanScope[1], "src/app.js")
})

test("extractReview normalizes string findings into typed details", () => {
  const review = extractReview(
    JSON.stringify({
      verdict: "approved",
      summary: "All good.",
      findings: ["No blocking issues."],
      risks: [],
      follow_up_steps: [],
      tests: ["Checked output."],
    }),
  )

  assert.equal(review.findingDetails.length, 1)
  assert.equal(review.findingDetails[0].severity, "medium")
  assert.equal(review.findings[0], "No blocking issues.")
})

test("extractReview falls back for non-json content", () => {
  const review = extractReview("Reviewer prose without JSON.")
  assert.equal(review.verdict, "needs_followup")
  assert.match(review.risks[0], /non-JSON/i)
})
