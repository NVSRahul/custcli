import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { LIVE_AGENT_NAME, LIVE_CONFIG_VERSION, prepareLiveConfig } from "../src/lib/live-config.js"
import { buildLiveLaunch, removeStaleLiveSession } from "../src/lib/live-session.js"

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

test("prepareLiveConfig writes Gemini bridge tools, runtime, and agent files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-config-"))
  const prepared = await prepareLiveConfig({
    cwd: tempRoot,
    plannerModel: "gemini-2.5-pro",
    plannerApprovalMode: "plan",
  })

  const settingsPath = path.join(prepared.liveConfigDir, "runtime", "settings.json")
  const manifestPath = path.join(prepared.liveConfigDir, "custcli-live.json")
  const agentPath = path.join(prepared.liveConfigDir, "agents", `${LIVE_AGENT_NAME}.md`)
  const planToolPath = path.join(prepared.liveConfigDir, "tools", "gemini_plan.ts")
  const reviewToolPath = path.join(prepared.liveConfigDir, "tools", "gemini_review.ts")
  const cliToolPath = path.join(prepared.liveConfigDir, "tools", "gemini_cli.ts")
  const bridgePath = path.join(prepared.liveConfigDir, "runtime", "bridge.ts")
  const agentsMdPath = path.join(prepared.liveConfigDir, "AGENTS.md")
  const pluginPath = path.join(prepared.liveConfigDir, "plugins", "enforce-gemini-first.ts")
  const geminiStatusPluginPath = path.join(prepared.liveConfigDir, "plugins", "gemini-status.ts")
  const geminiStatusViewPath = path.join(prepared.liveConfigDir, "plugins", "gemini-status-view.tsx")
  const tuiConfigPath = path.join(prepared.liveConfigDir, "tui.json")

  const [settingsRaw, manifestRaw, agentRaw, planToolRaw, reviewToolRaw, cliToolRaw, bridgeRaw, agentsMdRaw, pluginRaw, geminiStatusPluginRaw, geminiStatusViewRaw, tuiConfigRaw] = await Promise.all([
    fs.readFile(settingsPath, "utf8"),
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(agentPath, "utf8"),
    fs.readFile(planToolPath, "utf8"),
    fs.readFile(reviewToolPath, "utf8"),
    fs.readFile(cliToolPath, "utf8"),
    fs.readFile(bridgePath, "utf8"),
    fs.readFile(agentsMdPath, "utf8"),
    fs.readFile(pluginPath, "utf8"),
    fs.readFile(geminiStatusPluginPath, "utf8"),
    fs.readFile(geminiStatusViewPath, "utf8"),
    fs.readFile(tuiConfigPath, "utf8"),
  ])

  const settings = JSON.parse(settingsRaw)
  const manifest = JSON.parse(manifestRaw)
  const tuiConfig = JSON.parse(tuiConfigRaw)

  assert.equal(settings.defaultPlannerModel, "gemini-2.5-pro")
  assert.equal(settings.plannerMode, "free")
  assert.equal(settings.defaultApprovalMode, "plan")
  assert.equal(settings.geminiTimeoutMs, 180000)
  assert.equal(settings.geminiSandbox, true)
  assert.equal(settings.liveConfigVersion, LIVE_CONFIG_VERSION)
  assert.equal(manifest.plannerMode, "free")
  assert.deepEqual(tuiConfig.plugin, [path.join(prepared.liveConfigDir, "plugins", "gemini-status.ts")])
  assert.match(agentRaw, /gemini_plan/)
  assert.match(agentRaw, /gemini_review/)
  assert.match(agentRaw, /--verbose/)
  assert.match(agentRaw, /current workspace root/)
  assert.match(planToolRaw, /model/)
  assert.match(planToolRaw, /runPlanningTool/)
  assert.match(planToolRaw, /current workspace root/)
  assert.match(reviewToolRaw, /model/)
  assert.match(reviewToolRaw, /runReviewTool/)
  assert.match(reviewToolRaw, /current workspace root/)
  assert.match(cliToolRaw, /model/)
  assert.match(cliToolRaw, /runRawGeminiTool/)
  assert.match(cliToolRaw, /--verbose/)
  assert.match(cliToolRaw, /--worktree/)
  assert.match(bridgeRaw, /createPlannerPrompt/)
  assert.match(bridgeRaw, /modelToUse/)
  assert.match(bridgeRaw, /getGeminiSandboxEnabled/)
  assert.match(bridgeRaw, /buildWorkspaceScopedGeminiArgs/)
  assert.match(bridgeRaw, /sanitizeRawGeminiArgs/)
  assert.match(bridgeRaw, /sanitizeWorkspaceContext/)
  assert.match(bridgeRaw, /--include-directories/)
  assert.match(bridgeRaw, /--sandbox/)
  assert.match(bridgeRaw, /do not allow "--worktree"/)
  assert.match(agentsMdRaw, /Gemini/)
  assert.match(agentsMdRaw, /default `free` planner mode/)
  assert.match(agentsMdRaw, /-p`\/`--prompt/)
  assert.match(agentsMdRaw, /`\/test`/)
  assert.match(agentsMdRaw, /use `test\/`/)
  assert.match(agentsMdRaw, /Workspace root folder: \//)
  assert.match(agentsMdRaw, /sidebar can show Gemini status/)
  assert.match(agentsMdRaw, /Use Gemini as the external planner and reviewer/)
  assert.match(agentsMdRaw, /Prefer the simplest solution that fully solves the request/)
  assert.match(agentsMdRaw, /Do not explicitly say that you "learned" from Gemini/)
  assert.match(agentsMdRaw, /Do not write a report file unless the user explicitly asked for a file/)
  assert.match(agentsMdRaw, /send it in clean chunks or sections/)
  assert.match(agentRaw, /runtime plugin as authoritative/)
  assert.match(agentRaw, /Workspace root folder: \//)
  assert.match(agentRaw, /Use the live Gemini sidebar as the progress signal/)
  assert.match(agentRaw, /Use `test\/` or the full workspace path/)
  assert.match(agentRaw, /Treat Gemini as the primary planner, reviewer, and suggestion source/)
  assert.match(agentRaw, /Treat Gemini output as high-authority guidance/)
  assert.match(agentRaw, /Pass the concrete contradiction back through `gemini_plan` or `gemini_review`/)
  assert.match(agentRaw, /Use Gemini review to check correctness/)
  assert.match(agentRaw, /Do not explicitly say that you "learned" from Gemini/)
  assert.match(agentRaw, /Do not write a report file unless the user explicitly asked for a file/)
  assert.match(agentRaw, /send it in clean chunks or sections/)
  assert.match(pluginRaw, /STRICT RUNTIME RULE:/)
  assert.match(pluginRaw, /FREE PLANNER MODE:/)
  assert.match(pluginRaw, /Planner mode is strict/)
  assert.match(pluginRaw, /tool\.execute\.before/)
  assert.match(pluginRaw, /experimental\.chat\.system\.transform/)
  assert.match(pluginRaw, /--verbose/)
  assert.match(pluginRaw, /"\/test"/)
  assert.match(pluginRaw, /Workspace root folder: \//)
  assert.match(pluginRaw, /sanitizeGeminiArgs/)
  assert.match(pluginRaw, /output\.args = await sanitizeGeminiArgs/)
  assert.match(pluginRaw, /relative workspace paths such as "test\/"/)
  assert.match(pluginRaw, /Prefer the simplest solution that fully solves the request/)
  assert.match(pluginRaw, /Do not explicitly say you "learned" from Gemini/)
  assert.match(pluginRaw, /Do not write a report file unless the user explicitly asked for a file/)
  assert.match(pluginRaw, /send it in clean chunks or sections/)
  assert.match(pluginRaw, /plannerMode === "strict" \? "strict" : "free"/)
  assert.match(geminiStatusPluginRaw, /gemini-status-view\.tsx/)
  assert.match(geminiStatusViewRaw, /Gemini Live/)
  assert.match(geminiStatusViewRaw, /sidebar_content/)
  assert.match(geminiStatusViewRaw, /readGeminiStatus/)
  assert.match(geminiStatusViewRaw, /node:fs\/promises/)
  assert.match(geminiStatusViewRaw, /spinnerFrames = \["⠋"/)
  assert.match(geminiStatusViewRaw, /frameIndex/)
  assert.match(geminiStatusViewRaw, /live", "status"/)
  assert.match(bridgeRaw, /Gemini planner went quiet for/)
  assert.match(bridgeRaw, /Run `gemini` once in a normal terminal to finish sign-in/)
  assert.match(bridgeRaw, /getGeminiTimeoutMs/)
  assert.match(bridgeRaw, /Gemini model override/)
  assert.match(bridgeRaw, /workspaceRoot/)
  assert.match(bridgeRaw, /manifest\.workspaceRoot/)
  assert.match(bridgeRaw, /refused to run Gemini with workspace root '\/'/)
  assert.match(bridgeRaw, /isWithinRoot/)
  assert.match(bridgeRaw, /hit server capacity limits/)
  assert.match(bridgeRaw, /DEFAULT_GEMINI_TIMEOUT_MS = 180000/)
  assert.match(agentRaw, /Do not invent Gemini `model` overrides/)
  assert.match(agentsMdRaw, /Do not pass Gemini `model` overrides/)
  assert.match(pluginRaw, /Do not invent Gemini model overrides/)
  assert.match(bridgeRaw, /createGeminiProgressReporter/)
  assert.match(bridgeRaw, /GEMINI_PROGRESS_HEARTBEAT_MS = 1000/)
  assert.match(bridgeRaw, /context\.metadata/)
  assert.match(bridgeRaw, /geminiStatusPath/)
  assert.match(bridgeRaw, /writeGeminiStatus/)
})

test("prepareLiveConfig stores auto planner mode as an unpinned Gemini default", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-auto-model-"))
  const prepared = await prepareLiveConfig({
    cwd: tempRoot,
    plannerModel: undefined,
    plannerApprovalMode: "plan",
  })

  const settingsPath = path.join(prepared.liveConfigDir, "runtime", "settings.json")
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"))

  assert.equal(settings.defaultPlannerModel, null)
  assert.equal(settings.plannerMode, "free")
  assert.equal(settings.geminiTimeoutMs, 180000)
  assert.equal(settings.geminiSandbox, true)
  assert.equal(settings.liveConfigVersion, LIVE_CONFIG_VERSION)
})

test("prepareLiveConfig stores strict planner mode when requested", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-strict-mode-"))
  const prepared = await prepareLiveConfig({
    cwd: tempRoot,
    plannerModel: undefined,
    plannerMode: "strict",
    plannerApprovalMode: "plan",
  })

  const settingsPath = path.join(prepared.liveConfigDir, "runtime", "settings.json")
  const manifestPath = path.join(prepared.liveConfigDir, "custcli-live.json")
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"))
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))

  assert.equal(settings.plannerMode, "strict")
  assert.equal(manifest.plannerMode, "strict")
})

test("custcli live launches OpenCode with the generated live config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-run-"))
  const captureFile = path.join(tempRoot, "capture-live.json")
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_CAPTURE_FILE: captureFile,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-live.js")]),
  }

  const result = await runCli(["live", "--cwd", tempRoot, "improve", "the", "api", "handler"], env, path.resolve("."))
  assert.equal(result.code, 0, result.stderr)

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"))
  assert.equal(await fs.realpath(captured.cwd), await fs.realpath(tempRoot))
  assert.equal(captured.env.CUSTCLI_LIVE, "1")
  assert.ok(captured.env.OPENCODE_CONFIG_DIR)
  assert.ok(captured.argv.includes("--agent"))
  assert.ok(captured.argv.includes(LIVE_AGENT_NAME))
  assert.ok(captured.argv.includes("--prompt"))
  assert.ok(captured.argv.includes("improve the api handler"))

  const settingsPath = path.join(captured.env.OPENCODE_CONFIG_DIR, "runtime", "settings.json")
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"))
  assert.equal(settings.defaultApprovalMode, "plan")
  assert.equal(settings.plannerMode, "free")
})

test("custcli run --open-ui reuses the live OpenCode path", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-alias-"))
  const captureFile = path.join(tempRoot, "capture-alias.json")
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_CAPTURE_FILE: captureFile,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-live.js")]),
  }

  const result = await runCli(
    ["run", "--open-ui", "--cwd", tempRoot, "alias", "launch", "prompt"],
    env,
    path.resolve("."),
  )
  assert.equal(result.code, 0, result.stderr)

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"))
  assert.ok(captured.argv.includes("--agent"))
  assert.ok(captured.argv.includes(LIVE_AGENT_NAME))
  assert.ok(captured.argv.includes("--prompt"))
  assert.ok(captured.argv.includes("alias launch prompt"))
})

test("custcli live forwards strict planner mode into the generated config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-strict-launch-"))
  const captureFile = path.join(tempRoot, "capture-strict.json")
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_CAPTURE_FILE: captureFile,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-live.js")]),
  }

  const result = await runCli(["live", "--cwd", tempRoot, "--planner-mode", "strict"], env, path.resolve("."))
  assert.equal(result.code, 0, result.stderr)

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"))
  const settingsPath = path.join(captured.env.OPENCODE_CONFIG_DIR, "runtime", "settings.json")
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"))
  assert.equal(settings.plannerMode, "strict")
})

test("custcli live automatically continues the last live session unless a new one is requested", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-continue-"))
  const captureFile = path.join(tempRoot, "capture-continue.json")
  const env = {
    ...process.env,
    CUSTCLI_SESSION_DIR: path.join(tempRoot, ".custcli"),
    CUSTCLI_CAPTURE_FILE: captureFile,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-live.js")]),
  }

  const first = await runCli(["live", "--cwd", tempRoot, "first prompt"], env, path.resolve("."))
  assert.equal(first.code, 0, first.stderr)

  const second = await runCli(["live", "--cwd", tempRoot, "second prompt"], env, path.resolve("."))
  assert.equal(second.code, 0, second.stderr)

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"))
  assert.ok(captured.argv.includes("--continue"))
  assert.ok(captured.argv.includes("--prompt"))
  assert.ok(captured.argv.includes("second prompt"))
})

test("custcli live respects INIT_CWD when launched through npm from a subdirectory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-init-cwd-"))
  const nestedDir = path.join(tempRoot, "test")
  const captureFile = path.join(tempRoot, "capture-init-cwd.json")
  await fs.mkdir(nestedDir, { recursive: true })

  const env = {
    ...process.env,
    INIT_CWD: nestedDir,
    CUSTCLI_CAPTURE_FILE: captureFile,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-live.js")]),
  }

  const result = await runCli(["live", "--new-session"], env, path.resolve("."))
  assert.equal(result.code, 0, result.stderr)

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"))
  assert.equal(await fs.realpath(captured.cwd), await fs.realpath(nestedDir))
  assert.equal(
    await fs.realpath(captured.env.OPENCODE_CONFIG_DIR),
    await fs.realpath(path.join(nestedDir, ".custcli", "opencode-live")),
  )
})

test("custcli sessions lists known live session ids with workspace details", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-sessions-"))
  const artifactRoot = path.join(tempRoot, ".custcli")
  const liveDir = path.join(artifactRoot, "live")
  await fs.mkdir(path.join(liveDir, "state"), { recursive: true })
  await fs.mkdir(path.join(liveDir, "status"), { recursive: true })

  await fs.writeFile(
    path.join(liveDir, "state", "ses_alpha.json"),
    `${JSON.stringify(
      {
        geminiSessionId: "gemini-alpha",
        planCount: 2,
        reviewCount: 1,
        rawCount: 0,
        lastPlanDir: path.join(artifactRoot, "live", "sessions", "ses_alpha", "plan"),
        updatedAt: "2026-04-16T18:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await fs.writeFile(
    path.join(liveDir, "status", "ses_alpha.json"),
    `${JSON.stringify(
      {
        sessionID: "ses_alpha",
        title: "Gemini Plan",
        kind: "plan",
        phase: "completed",
        requestPreview: "Review the tests in this directory and summarize real issues.",
        workspaceRoot: tempRoot,
        updatedAt: Date.parse("2026-04-16T18:05:00.000Z"),
        artifactDir: path.join(artifactRoot, "live", "sessions", "ses_alpha", "latest"),
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await fs.writeFile(
    path.join(liveDir, "state", "ses_stale.json"),
    `${JSON.stringify(
      {
        geminiSessionId: null,
        planCount: 0,
        reviewCount: 0,
        rawCount: 1,
        lastRawDir: path.join(artifactRoot, "live", "sessions", "ses_stale", "raw"),
        updatedAt: "2026-04-16T18:04:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await fs.writeFile(
    path.join(liveDir, "status", "ses_stale.json"),
    `${JSON.stringify(
      {
        sessionID: "ses_stale",
        title: "Gemini CLI",
        kind: "raw",
        phase: "completed",
        requestPreview: "What is the current directory?",
        workspaceRoot: tempRoot,
        updatedAt: Date.parse("2026-04-16T18:04:00.000Z"),
        artifactDir: path.join(artifactRoot, "live", "sessions", "ses_stale", "raw"),
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const env = {
    ...process.env,
    CUSTCLI_OPENCODE_CMD_JSON: JSON.stringify([process.execPath, path.resolve("test/fixtures/mock-opencode-session-list.js")]),
  }

  const result = await runCli(["sessions", "--cwd", tempRoot, "--json"], env, path.resolve("."))
  assert.equal(result.code, 0, result.stderr)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.rootDir, artifactRoot)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].sessionId, "ses_alpha")
  assert.equal(payload.sessions[0].workspaceRoot, tempRoot)
  assert.equal(payload.sessions[0].geminiSessionId, "gemini-alpha")
  assert.equal(payload.sessions[0].phase, "completed")
  assert.match(payload.sessions[0].continueCommand, /custcli live --session ses_alpha --cwd/)
  assert.equal(payload.sessions[0].planCount, 2)
  assert.equal(payload.sessions[0].reviewCount, 1)
  assert.equal(payload.sessionValidation.available, true)
  assert.equal(payload.sessionValidation.hiddenStaleCount, 1)

  const resultAll = await runCli(["sessions", "--cwd", tempRoot, "--json", "--all"], env, path.resolve("."))
  assert.equal(resultAll.code, 0, resultAll.stderr)
  const payloadAll = JSON.parse(resultAll.stdout)
  assert.equal(payloadAll.sessions.length, 2)
  assert.equal(payloadAll.sessionValidation.hiddenStaleCount, 0)
})

test("removeStaleLiveSession deletes only explicitly confirmed stale metadata", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-remove-stale-"))
  const rootDir = path.join(tempRoot, ".custcli")
  const sessionId = "ses_stale"
  const statePath = path.join(rootDir, "live", "state", `${sessionId}.json`)
  const statusPath = path.join(rootDir, "live", "status", `${sessionId}.json`)
  const sessionDir = path.join(rootDir, "live", "sessions", sessionId)

  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await fs.mkdir(path.dirname(statusPath), { recursive: true })
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(statePath, "{}\n", "utf8")
  await fs.writeFile(statusPath, "{}\n", "utf8")
  await fs.writeFile(path.join(sessionDir, "marker.txt"), "ok\n", "utf8")

  await assert.rejects(
    () => removeStaleLiveSession({ rootDir, sessionId, knownStale: false }),
    /not confirmed stale/,
  )

  await removeStaleLiveSession({ rootDir, sessionId, knownStale: true })

  await assert.rejects(() => fs.access(statePath))
  await assert.rejects(() => fs.access(statusPath))
  await assert.rejects(() => fs.access(sessionDir))
})

test("buildLiveLaunch does not auto-continue when the previous live config version is stale", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custcli-live-stale-version-"))
  const lastLaunchPath = path.join(tempRoot, ".custcli", "live", "last-launch.json")

  await fs.mkdir(path.dirname(lastLaunchPath), { recursive: true })
  await fs.writeFile(
    lastLaunchPath,
    `${JSON.stringify(
      {
        liveConfigVersion: LIVE_CONFIG_VERSION - 1,
        opencodeConfigDir: path.join(tempRoot, ".custcli", "opencode-live"),
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const launch = await buildLiveLaunch({
    cwd: tempRoot,
    prompt: "check stale config",
  })

  assert.equal(launch.shouldAutoContinue, false)
  assert.equal(launch.shouldContinue, false)
})
