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

async function touchOld(targetPath, ageMs = 10 * 24 * 60 * 60 * 1000) {
  const oldDate = new Date(Date.now() - ageMs)
  await fs.utimes(targetPath, oldDate, oldDate)
}

async function write(filePath, content = "ok\n") {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
}

test("custcli prune keeps continuity files, removes stale live metadata, and trims old heavy artifacts", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-prune-"))
  const artifactRoot = path.join(tempRoot, ".custcli")

  await Promise.all([
    write(path.join(artifactRoot, "live", "last-launch.json"), "{}\n"),
    write(path.join(artifactRoot, "knowledge", "executions.jsonl"), '{"runId":"1"}\n'),
    write(path.join(artifactRoot, "live", "state", "ses_alpha.json"), '{"planCount":1}\n'),
    write(path.join(artifactRoot, "live", "status", "ses_alpha.json"), JSON.stringify({
      sessionID: "ses_alpha",
      phase: "completed",
      workspaceRoot: tempRoot,
      updatedAt: Date.now(),
    }) + "\n"),
    write(path.join(artifactRoot, "live", "state", "ses_stale.json"), '{"rawCount":1}\n'),
    write(path.join(artifactRoot, "live", "status", "ses_stale.json"), JSON.stringify({
      sessionID: "ses_stale",
      phase: "completed",
      workspaceRoot: tempRoot,
      updatedAt: Date.now() - 1000,
    }) + "\n"),
    write(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-plan", "planner-stdout.json"), "{}\n"),
    write(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-plan", "plan.json"), "{}\n"),
    write(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-01-new-plan", "planner-stdout.json"), "{}\n"),
    write(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-01-new-plan", "plan.json"), "{}\n"),
    write(path.join(artifactRoot, "live", "sessions", "ses_stale", "2026-04-17T00-00-00-raw", "stdout.log"), "old\n"),
    write(path.join(artifactRoot, "sessions", "run-old", "planner-stdout.json"), "{}\n"),
    write(path.join(artifactRoot, "sessions", "run-old", "planner-stderr.log"), "old\n"),
    write(path.join(artifactRoot, "sessions", "run-old", "plan.json"), '{"goal":"full"}\n'),
    write(path.join(artifactRoot, "sessions", "run-old", "plan-compact.json"), '{"goal":"compact"}\n'),
    write(path.join(artifactRoot, "sessions", "run-old", "review.json"), '{"verdict":"approved"}\n'),
    write(path.join(artifactRoot, "sessions", "run-old", "review-compact.json"), '{"verdict":"approved"}\n'),
    write(path.join(artifactRoot, "sessions", "run-old", "summary.json"), '{"goal":"summary"}\n'),
    write(path.join(artifactRoot, "sessions", "run-new", "planner-stdout.json"), "{}\n"),
    write(path.join(artifactRoot, "sessions", "run-new", "plan.json"), '{"goal":"latest"}\n'),
    write(path.join(artifactRoot, "sessions", "run-new", "plan-compact.json"), '{"goal":"latest-compact"}\n'),
  ])

  await Promise.all([
    touchOld(path.join(artifactRoot, "sessions", "run-old")),
    touchOld(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-plan")),
    touchOld(path.join(artifactRoot, "live", "sessions", "ses_stale")),
  ])

  const env = {
    ...process.env,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-session-list.js")]),
  }

  const result = await runCli(
    ["prune", "--cwd", tempRoot, "--keep-last", "1", "--json"],
    env,
    path.resolve("."),
  )

  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.keepLast, 1)
  assert.equal(summary.rawOnly, false)
  assert.equal(summary.live.staleSessionsRemoved, 1)
  assert.equal(summary.headless.touchedRuns, 1)

  await fs.access(path.join(artifactRoot, "live", "last-launch.json"))
  await fs.access(path.join(artifactRoot, "knowledge", "executions.jsonl"))
  await fs.access(path.join(artifactRoot, "sessions", "run-old", "plan-compact.json"))
  await fs.access(path.join(artifactRoot, "sessions", "run-old", "review-compact.json"))
  await fs.access(path.join(artifactRoot, "sessions", "run-old", "summary.json"))
  await fs.access(path.join(artifactRoot, "sessions", "run-new", "plan.json"))

  await assert.rejects(() => fs.access(path.join(artifactRoot, "sessions", "run-old", "planner-stdout.json")))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "sessions", "run-old", "planner-stderr.log")))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "sessions", "run-old", "plan.json")))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "sessions", "run-old", "review.json")))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-plan")))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "live", "state", "ses_stale.json")))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "live", "status", "ses_stale.json")))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "live", "sessions", "ses_stale")))
})

test("custcli prune --raw-only keeps full plan/review files while trimming raw files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-prune-raw-only-"))
  const artifactRoot = path.join(tempRoot, ".custcli")

  await Promise.all([
    write(path.join(artifactRoot, "sessions", "run-old", "planner-stdout.json"), "{}\n"),
    write(path.join(artifactRoot, "sessions", "run-old", "plan.json"), '{"goal":"full"}\n'),
    write(path.join(artifactRoot, "sessions", "run-old", "review.json"), '{"verdict":"approved"}\n'),
    write(path.join(artifactRoot, "sessions", "run-old", "review-compact.json"), '{"verdict":"approved"}\n'),
    write(path.join(artifactRoot, "live", "state", "ses_alpha.json"), '{"planCount":1}\n'),
    write(path.join(artifactRoot, "live", "status", "ses_alpha.json"), JSON.stringify({
      sessionID: "ses_alpha",
      phase: "completed",
      workspaceRoot: tempRoot,
      updatedAt: Date.now(),
    }) + "\n"),
    write(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-review", "review-stdout.json"), "{}\n"),
    write(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-review", "review.json"), '{"verdict":"approved"}\n'),
    write(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-01-new-review", "review-stdout.json"), "{}\n"),
  ])

  await Promise.all([
    touchOld(path.join(artifactRoot, "sessions", "run-old")),
    touchOld(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-review")),
  ])

  const env = {
    ...process.env,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-session-list.js")]),
  }

  const result = await runCli(
    ["prune", "--cwd", tempRoot, "--keep-last", "0", "--raw-only", "--older-than", "7d", "--json"],
    env,
    path.resolve("."),
  )

  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.rawOnly, true)

  await assert.rejects(() => fs.access(path.join(artifactRoot, "sessions", "run-old", "planner-stdout.json")))
  await fs.access(path.join(artifactRoot, "sessions", "run-old", "plan.json"))
  await fs.access(path.join(artifactRoot, "sessions", "run-old", "review.json"))
  await assert.rejects(() => fs.access(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-review", "review-stdout.json")))
  await fs.access(path.join(artifactRoot, "live", "sessions", "ses_alpha", "2026-04-17T00-00-00-old-review", "review.json"))
})
