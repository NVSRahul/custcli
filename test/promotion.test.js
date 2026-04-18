import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compilePromotions, persistPromotions } from "../src/lib/promotion.js"
import { appendJsonl } from "../src/lib/session-store.js"

test("compilePromotions promotes only validated repeated useful candidates", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-promotion-"))
  const rootDir = path.join(tempRoot, ".custcli")
  const cwd = tempRoot

  await appendJsonl(path.join(rootDir, "knowledge", "executions.jsonl"), {
    cwd,
    prompt: "Ship feature with stronger review loop",
    goal: "Ship feature",
    reasoningSummary: "Use strong review",
    workerStatus: "approved",
  })

  const promotions = await compilePromotions({
    rootDir,
    cwd,
    prompt: "Ship feature with stronger review loop",
    plan: {
      goal: "Ship feature",
      successCriteria: ["Feature ships cleanly."],
    },
    review: {
      verdict: "approved",
      summary: "Approved.",
      tests: ["Reviewed the final output."],
    },
    evidenceGraph: {
      summary: "Verified all steps.",
      stepEvidence: [
        {
          writeScope: ["src/app.js"],
          verificationRules: ["Reviewed the final output."],
        },
      ],
    },
    contradictions: [],
    routing: {
      summary: "Use strong review when contradiction pressure rises.",
    },
  })

  assert.ok(promotions.candidates.length >= 1)
  assert.ok(promotions.promoted.length >= 1)

  const persisted = await persistPromotions({
    rootDir,
    cwd,
    runId: "run-1",
    promotions,
  })

  assert.equal(persisted.length, promotions.promoted.length)
})

test("compilePromotions holds candidates when validation gates are missing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-promotion-hold-"))
  const rootDir = path.join(tempRoot, ".custcli")

  const promotions = await compilePromotions({
    rootDir,
    cwd: tempRoot,
    prompt: "One-off task",
    plan: {
      goal: "One-off task",
      successCriteria: ["Task works once."],
    },
    review: {
      verdict: "changes_requested",
      summary: "Needs follow-up.",
      tests: [],
    },
    evidenceGraph: {
      summary: "Evidence incomplete.",
      stepEvidence: [],
    },
    contradictions: [{ id: "c-1" }],
    routing: {
      summary: "Increase review when contradictions exist.",
    },
  })

  assert.ok(promotions.candidates.length >= 1)
  assert.equal(promotions.promoted.length, 0)
})
