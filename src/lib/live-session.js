import fs from "node:fs/promises"
import path from "node:path"
import { LIVE_CONFIG_VERSION, prepareLiveConfig } from "./live-config.js"
import { getOpencodeCommandSpec } from "./opencode-adapter.js"
import { runCommand, runInherited } from "./process.js"

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function readJsonDirectory(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    return Promise.all(
      files.map(async (entry) => ({
        id: entry.name.replace(/\.json$/i, ""),
        value: await readJson(path.join(dirPath, entry.name)),
      })),
    )
  } catch {
    return []
  }
}

function resolveArtifactRoot(cwd, artifactRoot) {
  return path.resolve(artifactRoot ?? process.env.CUSTCLI_SESSION_DIR ?? path.join(cwd, ".custcli"))
}

function clipText(text, limit = 72) {
  const value = String(text ?? "").trim().replace(/\s+/g, " ")
  if (!value) return null
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function inferSessionName(sessionId, state, status) {
  return (
    clipText(status?.requestPreview) ??
    clipText(status?.summary) ??
    clipText(status?.title) ??
    clipText(status?.toolTitle) ??
    clipText(state?.lastPromptPreview) ??
    `Session ${sessionId}`
  )
}

function inferArtifactDir(state, status) {
  return (
    status?.artifactDir ??
    state?.lastPlanDir ??
    state?.lastReviewDir ??
    state?.lastRawDir ??
    null
  )
}

function parseOpencodeSessionList(text) {
  try {
    const value = JSON.parse(String(text || "").trim() || "[]")
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

async function listOpencodeSessions({ cwd, commandSpec = getOpencodeCommandSpec() }) {
  try {
    const result = await runCommand({
      commandSpec,
      args: ["session", "list", "--format", "json"],
      cwd,
    })

    if (!result.ok) {
      return {
        available: false,
        sessions: [],
        error: (result.stderr || result.stdout || "OpenCode session list failed").trim(),
      }
    }

    return {
      available: true,
      sessions: parseOpencodeSessionList(result.stdout),
      error: null,
    }
  } catch (error) {
    return {
      available: false,
      sessions: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function listLiveSessions({ cwd, artifactRoot, includeStale = false }) {
  const rootDir = resolveArtifactRoot(cwd, artifactRoot)
  const liveDir = path.join(rootDir, "live")
  const [stateEntries, statusEntries, lastLaunch, opencode] = await Promise.all([
    readJsonDirectory(path.join(liveDir, "state")),
    readJsonDirectory(path.join(liveDir, "status")),
    readJson(path.join(liveDir, "last-launch.json")),
    listOpencodeSessions({ cwd }),
  ])

  const sessions = new Map()
  const opencodeById = new Map(
    opencode.sessions
      .filter((item) => item && typeof item === "object" && typeof item.id === "string")
      .map((item) => [item.id, item]),
  )

  for (const entry of stateEntries) {
    const current = sessions.get(entry.id) ?? { sessionId: entry.id }
    current.state = entry.value ?? {}
    sessions.set(entry.id, current)
  }

  for (const entry of statusEntries) {
    const sessionId = String(entry.value?.sessionID ?? entry.id)
    const current = sessions.get(sessionId) ?? { sessionId }
    current.status = entry.value ?? {}
    sessions.set(sessionId, current)
  }

  const items = Array.from(sessions.values())
    .map((item) => {
      const state = item.state ?? {}
      const status = item.status ?? {}
      const updatedAtMs =
        normalizeTimestamp(status.updatedAt) ??
        normalizeTimestamp(status.lastActivityAt) ??
        normalizeTimestamp(state.updatedAt)

      const workspaceRoot =
        status.workspaceRoot ??
        state.workspaceRoot ??
        (typeof opencodeById.get(item.sessionId)?.directory === "string" ? opencodeById.get(item.sessionId).directory : null) ??
        (lastLaunch?.cwd && typeof lastLaunch.cwd === "string" ? lastLaunch.cwd : null)

      const opencodeSession = opencodeById.get(item.sessionId)
      const existsInOpencode = Boolean(opencodeSession)
      const opencodeUpdatedAtMs = normalizeTimestamp(opencodeSession?.updated)

      return {
        sessionId: item.sessionId,
        name: inferSessionName(item.sessionId, state, {
          ...status,
          title: status?.title ?? opencodeSession?.title,
          toolTitle: status?.toolTitle ?? opencodeSession?.title,
        }),
        workspaceRoot,
        phase: status.phase ?? "unknown",
        kind: status.kind ?? null,
        geminiSessionId: state.geminiSessionId ?? status.geminiSessionId ?? null,
        planCount: Number(state.planCount ?? 0),
        reviewCount: Number(state.reviewCount ?? 0),
        rawCount: Number(state.rawCount ?? 0),
        artifactDir: inferArtifactDir(state, status),
        updatedAt: updatedAtMs || opencodeUpdatedAtMs ? new Date(updatedAtMs ?? opencodeUpdatedAtMs).toISOString() : null,
        updatedAtMs: updatedAtMs ?? opencodeUpdatedAtMs ?? 0,
        requestPreview: clipText(status.requestPreview, 120),
        existsInOpencode,
        stale: !existsInOpencode,
        continueCommand: workspaceRoot
          ? `custcli live --session ${item.sessionId} --cwd "${workspaceRoot}"${
              path.join(workspaceRoot, ".custcli") !== rootDir ? ` --artifact-root "${rootDir}"` : ""
            }`
          : `custcli live --session ${item.sessionId}`,
      }
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)

  const staleCount = items.filter((item) => !item.existsInOpencode).length
  const filteredSessions = opencode.available && !includeStale ? items.filter((item) => item.existsInOpencode) : items

  return {
    rootDir,
    lastLaunch,
    sessionValidation: {
      available: opencode.available,
      error: opencode.error,
      hiddenStaleCount: opencode.available && !includeStale ? staleCount : 0,
    },
    sessions: filteredSessions,
  }
}

export async function removeStaleLiveSession({ rootDir, sessionId, knownStale = false }) {
  if (!knownStale) {
    throw new Error(`Refused to delete session "${sessionId}" because it is not confirmed stale.`)
  }

  const safeId = String(sessionId ?? "").trim()
  if (!safeId) {
    throw new Error("Session ID is required.")
  }

  const targets = [
    path.join(rootDir, "live", "state", `${safeId}.json`),
    path.join(rootDir, "live", "status", `${safeId}.json`),
    path.join(rootDir, "live", "sessions", safeId),
  ]

  await Promise.all(targets.map((target) => fs.rm(target, { recursive: true, force: true })))

  return {
    sessionId: safeId,
    removed: targets,
  }
}

export async function buildLiveLaunch({
  cwd,
  prompt,
  plannerModel,
  plannerMode = "free",
  workerModel,
  workerAgent,
  plannerApprovalMode = "plan",
  artifactRoot,
  continueSession = false,
  session,
  newSession = false,
  fork = false,
  commandSpec = getOpencodeCommandSpec(),
}) {
  const config = await prepareLiveConfig({
    cwd,
    artifactRoot,
    plannerModel,
    plannerMode,
    plannerApprovalMode,
  })

  const args = []
  const lastLaunchPath = path.join(config.rootDir, "live", "last-launch.json")
  const lastLaunch = (await exists(lastLaunchPath)) ? await readJson(lastLaunchPath) : null
  const canAutoContinue =
    lastLaunch &&
    Number(lastLaunch.liveConfigVersion ?? 0) === LIVE_CONFIG_VERSION &&
    lastLaunch.opencodeConfigDir === config.liveConfigDir
  const shouldAutoContinue = !session && !continueSession && !newSession && Boolean(canAutoContinue)
  const shouldContinue = !session && (continueSession || shouldAutoContinue)

  if (workerModel) args.push("--model", workerModel)
  args.push("--agent", workerAgent ?? config.agentName)
  if (shouldContinue) args.push("--continue")
  if (session) args.push("--session", session)
  if (fork) args.push("--fork")
  if (prompt) args.push("--prompt", prompt)

  const env = {
    ...process.env,
    CUSTCLI_LIVE: "1",
    OPENCODE_CONFIG_DIR: config.liveConfigDir,
  }

  return {
    ...config,
    cwd,
    args,
    env,
    commandSpec,
    shouldContinue,
    shouldAutoContinue,
  }
}

export async function runLiveSession(options) {
  const launch = await buildLiveLaunch(options)

  await writeJson(path.join(launch.rootDir, "live", "last-launch.json"), {
    liveConfigVersion: LIVE_CONFIG_VERSION,
    cwd: launch.cwd,
    agentName: launch.args[1],
    opencodeConfigDir: launch.liveConfigDir,
    commandSpec: launch.commandSpec,
    args: launch.args,
    shouldContinue: launch.shouldContinue,
    autoContinued: launch.shouldAutoContinue,
    launchedAt: new Date().toISOString(),
  })

  await runInherited({
    commandSpec: launch.commandSpec,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
  })

  return launch
}
