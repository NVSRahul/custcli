import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

async function runCli(args, env, cwd) {
  const cliPath = path.resolve(cwd, "bin/custcli.js")
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

test("custcli run orchestrates planner and worker with mock commands", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-test-"))
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_GEMINI_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-gemini.js")]),
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode.js")]),
  }

  const result = await runCli(
    ["run", "--json", "--cwd", tempRoot, "build", "a", "custom", "planner-worker", "loop"],
    env,
    path.resolve("."),
  )

  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.goal, "Build the requested feature with the mock planner")
  assert.equal(summary.worker.status, "completed")
  assert.match(summary.worker.finalText, /Mock worker executed/)
  assert.equal(summary.review.verdict, "approved")
  assert.equal(summary.correctionLoopCount, 0)
  assert.equal(summary.evidence.verifiedStepCount, 1)
  assert.equal(summary.routing.loopBudget, 1)

  const planPath = path.join(summary.artifactDir, "plan.json")
  const compactPlanPath = path.join(summary.artifactDir, "plan-compact.json")
  const workerEventsPath = path.join(summary.artifactDir, "worker-events.json")
  const reviewPath = path.join(summary.artifactDir, "review.json")
  const compactReviewPath = path.join(summary.artifactDir, "review-compact.json")
  const evidencePath = path.join(summary.artifactDir, "evidence-graph.json")
  const promotionsPath = path.join(summary.artifactDir, "promotions.json")
  const memoryHotPath = path.join(summary.artifactDir, "memory-hot.json")

  const [planRaw, compactPlanRaw, workerEventsRaw, reviewRaw, compactReviewRaw, evidenceRaw, promotionsRaw, memoryHotRaw] = await Promise.all([
    fs.readFile(planPath, "utf8"),
    fs.readFile(compactPlanPath, "utf8"),
    fs.readFile(workerEventsPath, "utf8"),
    fs.readFile(reviewPath, "utf8"),
    fs.readFile(compactReviewPath, "utf8"),
    fs.readFile(evidencePath, "utf8"),
    fs.readFile(promotionsPath, "utf8"),
    fs.readFile(memoryHotPath, "utf8"),
  ])

  const plan = JSON.parse(planRaw)
  const compactPlan = JSON.parse(compactPlanRaw)
  const workerEvents = JSON.parse(workerEventsRaw)
  const review = JSON.parse(reviewRaw)
  const compactReview = JSON.parse(compactReviewRaw)
  const evidence = JSON.parse(evidenceRaw)
  const promotions = JSON.parse(promotionsRaw)
  const memoryHot = JSON.parse(memoryHotRaw)

  assert.equal(plan.executionSteps.length, 1)
  assert.equal(compactPlan.executionSteps.length, 1)
  assert.ok(Array.isArray(plan.executionSteps[0].claims))
  assert.equal(workerEvents.length, 3)
  assert.equal(review.verdict, "approved")
  assert.equal(compactReview.verdict, "approved")
  assert.equal(evidence.verifiedStepCount, 1)
  assert.equal(promotions.candidates.length >= promotions.promoted.length, true)
  assert.equal(memoryHot.evidence.verifiedStepCount, 1)
})

test("custcli run performs one correction loop when review requests changes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-test-review-loop-"))
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_GEMINI_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-gemini-review-loop.js")]),
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode.js")]),
  }

  const result = await runCli(["run", "--json", "--cwd", tempRoot, "improve", "the", "implementation"], env, path.resolve("."))
  assert.equal(result.code, 0, result.stderr)

  const summary = JSON.parse(result.stdout)
  assert.equal(summary.review.verdict, "approved")
  assert.equal(summary.correctionLoopCount, 1)
  assert.equal(summary.contradictionCount, 2)
  assert.equal(summary.routing.loopBudget, 2)

  const [historyRaw, contradictionsRaw, planPass2Raw, compactPlanPass2Raw, compactReviewPass2Raw, evidencePass2Raw] = await Promise.all([
    fs.readFile(path.join(summary.artifactDir, "review-history.json"), "utf8"),
    fs.readFile(path.join(summary.artifactDir, "contradictions.json"), "utf8"),
    fs.readFile(path.join(summary.artifactDir, "plan-pass-2.json"), "utf8"),
    fs.readFile(path.join(summary.artifactDir, "plan-compact-pass-2.json"), "utf8"),
    fs.readFile(path.join(summary.artifactDir, "review-compact-pass-2.json"), "utf8"),
    fs.readFile(path.join(summary.artifactDir, "evidence-compact-pass-2.json"), "utf8"),
  ])

  const history = JSON.parse(historyRaw)
  const contradictions = JSON.parse(contradictionsRaw)
  const secondPlan = JSON.parse(planPass2Raw)
  const compactSecondPlan = JSON.parse(compactPlanPass2Raw)
  const compactSecondReview = JSON.parse(compactReviewPass2Raw)
  const compactSecondEvidence = JSON.parse(evidencePass2Raw)

  assert.equal(history.length, 2)
  assert.equal(history[0].verdict, "changes_requested")
  assert.equal(history[1].verdict, "approved")
  assert.equal(contradictions.length, 2)
  assert.equal(contradictions[0].contradictionTarget, "step-1")
  assert.match(secondPlan.goal, /corrected implementation/i)
  assert.match(compactSecondPlan.goal, /corrected implementation/i)
  assert.equal(compactSecondReview.verdict, "approved")
  assert.equal(compactSecondEvidence.stepEvidence.length, 1)
})

test("custcli plan fails fast with actionable guidance when Gemini stalls in headless mode", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-test-timeout-"))
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_GEMINI_TIMEOUT_MS: "50",
    CUSTCLI_GEMINI_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-gemini-hang.js")]),
  }

  const result = await runCli(["plan", "--cwd", tempRoot, "debug", "the", "planner"], env, path.resolve("."))

  assert.equal(result.code, 1)
  assert.match(result.stderr, /Gemini planner went quiet for 50ms/)
  assert.match(result.stderr, /Run `gemini` once in a normal terminal to finish sign-in/)
  assert.match(result.stderr, /--approval-mode plan/)
})

test("custcli plan retries without an explicit model override when the requested Gemini model is unavailable", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-test-model-fallback-"))
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_GEMINI_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-gemini-model-fallback.js")]),
  }

  const result = await runCli(
    ["plan", "--json", "--cwd", tempRoot, "--planner-model", "gemini-2.0-flash", "review", "the", "project"],
    env,
    path.resolve("."),
  )

  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.goal, "Review the codebase with the fallback planner")
  assert.match(summary.plannerWarning, /retried without an explicit model override/)
})

test("custcli plan retries without an explicit model override when the pinned Gemini model is capacity-limited", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-test-capacity-fallback-"))
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_GEMINI_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-gemini-capacity-fallback.js")]),
  }

  const result = await runCli(
    ["plan", "--json", "--cwd", tempRoot, "--planner-model", "gemini-3.1-pro-preview", "review", "the", "project"],
    env,
    path.resolve("."),
  )

  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.goal, "Review the codebase with the capacity fallback planner")
  assert.match(summary.plannerWarning, /hit server capacity limits/)
})

test("custcli plan treats --planner-model auto as an unpinned Gemini request", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-test-auto-model-"))
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_GEMINI_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-gemini.js")]),
  }

  const result = await runCli(
    ["plan", "--json", "--cwd", tempRoot, "--planner-model", "auto", "review", "the", "project"],
    env,
    path.resolve("."),
  )

  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.goal, "Build the requested feature with the mock planner")
  assert.equal(summary.plannerWarning, null)
})

test("custcli plan locks Gemini to the current workspace with include-directories and sandbox flags", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-test-workspace-locked-"))
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_GEMINI_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-gemini-workspace-locked.js")]),
  }

  const result = await runCli(["plan", "--json", "--cwd", tempRoot, "review", "the", "project"], env, path.resolve("."))

  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.goal, "Review the workspace with locked Gemini scope")
})
