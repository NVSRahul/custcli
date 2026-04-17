#!/usr/bin/env node

const args = process.argv.slice(2)
const promptIndex = args.lastIndexOf("-p")
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : ""

const isReviewPrompt = /You are reviewing work performed by OpenCode/i.test(prompt)
const isCorrectionPlan = /This is correction planning pass 2\./i.test(prompt)
const isSecondReview = /This is review pass 2 after follow-up changes\./i.test(prompt)

let response
if (isReviewPrompt) {
  response = isSecondReview
    ? {
        verdict: "approved",
        summary: "Follow-up review approved the corrected implementation.",
        findings: ["Prior reviewer concerns were addressed."],
        risks: [],
        follow_up_steps: [],
        tests: ["Reviewed the second execution pass."],
      }
    : {
        verdict: "changes_requested",
        summary: "Initial review found a contradiction that needs a corrected plan.",
        findings: ["The first execution pass needs a follow-up correction."],
        risks: ["The current implementation may not satisfy the request fully."],
        follow_up_steps: ["Re-plan using the reviewer contradiction and execute one more pass."],
        tests: ["Reviewed the first execution pass."],
      }
} else {
  response = {
    goal: isCorrectionPlan ? "Apply the corrected implementation" : "Build the requested feature with a review loop",
    workspace_summary: isCorrectionPlan
      ? "This corrected plan addresses the reviewer contradiction."
      : "Initial planner response for review-loop testing.",
    reasoning_summary: isCorrectionPlan
      ? "Use a second pass to resolve the reviewer concern."
      : "Produce a first pass and let the mandatory reviewer decide whether a correction loop is needed.",
    decision_log: [isCorrectionPlan ? "Correction planning pass generated." : "Initial planning pass generated."],
    findings: [isCorrectionPlan ? "Reviewer contradiction incorporated into the corrected plan." : "Initial planning completed."],
    assumptions: [],
    risks: [],
    execution_steps: [
      {
        id: "step-1",
        title: isCorrectionPlan ? "Apply follow-up correction" : "Implement first pass",
        description: isCorrectionPlan
          ? "Execute the corrected follow-up implementation."
          : "Execute the initial implementation for the request.",
        opencodePrompt: isCorrectionPlan
          ? "Apply the follow-up correction requested by the reviewer."
          : "Implement the initial version of the requested work.",
        dependsOn: [],
        doneWhen: ["Worker reports completion without errors."],
      },
    ],
    replan_triggers: ["Reviewer requests changes."],
    success_criteria: [isCorrectionPlan ? "Reviewer approves the corrected pass." : "First implementation pass completes."],
  }
}

process.stdout.write(
  JSON.stringify({
    session_id: "gemini-review-loop-session",
    response: JSON.stringify(response),
  }),
)
