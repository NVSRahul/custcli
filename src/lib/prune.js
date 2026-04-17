import fs from "node:fs/promises"
import path from "node:path"
import { listLiveSessions, removeStaleLiveSession } from "./live-session.js"

const HEADLESS_RAW_FILE_RE =
  /^(planner-(prompt|stdout|stderr|envelope)|review-(prompt|stdout|stderr|envelope)|worker-(prompt|stdout|stderr|events))(?:-pass-\d+)?\.(txt|json|jsonl|log)$/i
const HEADLESS_FULL_PLAN_RE = /^plan(?:-pass-\d+)?\.json$/i
const HEADLESS_FULL_REVIEW_RE = /^review(?:-pass-\d+)?\.json$/i
const LIVE_RAW_FILE_RE = /^(planner-(prompt|stdout|stderr|envelope)|review-(prompt|stdout|stderr|envelope)|request)\.(txt|json|log)$/i

function resolveArtifactRoot(cwd, artifactRoot) {
  return path.resolve(artifactRoot ?? process.env.CUSTCLI_SESSION_DIR ?? path.join(cwd, ".custcli"))
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function listDirectories(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name)
          const stats = await fs.stat(fullPath)
          return {
            name: entry.name,
            path: fullPath,
            mtimeMs: stats.mtimeMs,
          }
        }),
    )
  } catch {
    return []
  }
}

function parseOlderThan(spec) {
  if (!spec) return null
  const normalized = String(spec).trim().toLowerCase()
  const match = normalized.match(/^(\d+)(ms|s|m|h|d|w)$/)
  if (!match) {
    throw new Error(`Unsupported age spec "${spec}". Use values like 30m, 12h, 7d, or 2w.`)
  }

  const value = Number.parseInt(match[1], 10)
  const unit = match[2]
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60 * 1000
          : unit === "h"
            ? 60 * 60 * 1000
            : unit === "d"
              ? 24 * 60 * 60 * 1000
              : 7 * 24 * 60 * 60 * 1000
  return value * multiplier
}

function shouldPruneEntry({ index, entry, keepLast, cutoffMs }) {
  if (index < keepLast) return false
  if (cutoffMs !== null && entry.mtimeMs > cutoffMs) return false
  return true
}

async function pruneFilesInDirectory(dirPath, shouldDeleteFile) {
  let deletedFiles = 0
  const deletedPaths = []

  let entries = []
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return { deletedFiles, deletedPaths }
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fullPath = path.join(dirPath, entry.name)
    if (!shouldDeleteFile(entry.name)) continue
    await fs.rm(fullPath, { force: true })
    deletedFiles += 1
    deletedPaths.push(fullPath)
  }

  return { deletedFiles, deletedPaths }
}

async function pruneHeadlessSessions({ rootDir, keepLast, rawOnly, cutoffMs }) {
  const sessionsDir = path.join(rootDir, "sessions")
  const dirs = (await listDirectories(sessionsDir)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const prunable = dirs.filter((entry, index) => shouldPruneEntry({ index, entry, keepLast, cutoffMs }))

  const stats = {
    totalRuns: dirs.length,
    eligibleRuns: prunable.length,
    deletedFiles: 0,
    deletedDirs: 0,
    touchedRuns: 0,
    removed: [],
  }

  for (const entry of prunable) {
    const result = await pruneFilesInDirectory(entry.path, (name) => {
      if (HEADLESS_RAW_FILE_RE.test(name)) return true
      if (rawOnly) return false
      if (HEADLESS_FULL_PLAN_RE.test(name) && !/^plan-compact(?:-pass-\d+)?\.json$/i.test(name)) return true
      if (HEADLESS_FULL_REVIEW_RE.test(name) && !/^review-compact(?:-pass-\d+)?\.json$/i.test(name)) return true
      return false
    })

    if (result.deletedFiles > 0) {
      stats.touchedRuns += 1
      stats.deletedFiles += result.deletedFiles
      stats.removed.push(...result.deletedPaths)
    }
  }

  return stats
}

async function pruneLiveSessions({ cwd, rootDir, keepLast, rawOnly, cutoffMs }) {
  const liveSessionsDir = path.join(rootDir, "live", "sessions")
  const liveResult = await listLiveSessions({
    cwd,
    artifactRoot: rootDir,
    includeStale: true,
  })

  const stats = {
    sessionValidation: liveResult.sessionValidation,
    staleSessionsRemoved: 0,
    staleSessionsSkipped: 0,
    deletedFiles: 0,
    deletedDirs: 0,
    removed: [],
  }

  if (liveResult.sessionValidation.available) {
    for (const item of liveResult.sessions) {
      if (!item.stale) continue
      await removeStaleLiveSession({
        rootDir,
        sessionId: item.sessionId,
        knownStale: true,
      })
      stats.staleSessionsRemoved += 1
      stats.deletedDirs += 1
      stats.removed.push(path.join(liveSessionsDir, item.sessionId))
    }
  } else {
    stats.staleSessionsSkipped = liveResult.sessions.filter((item) => item.stale).length
  }

  const remainingSessionDirs = (await listDirectories(liveSessionsDir)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const sessionDir of remainingSessionDirs) {
    const callDirs = (await listDirectories(sessionDir.path)).sort((a, b) => b.mtimeMs - a.mtimeMs)
    const prunableCalls = callDirs.filter((entry, index) => shouldPruneEntry({ index, entry, keepLast, cutoffMs }))

    for (const callDir of prunableCalls) {
      if (rawOnly) {
        const result = await pruneFilesInDirectory(callDir.path, (name) => LIVE_RAW_FILE_RE.test(name))
        if (result.deletedFiles > 0) {
          stats.deletedFiles += result.deletedFiles
          stats.removed.push(...result.deletedPaths)
        }
        continue
      }

      await fs.rm(callDir.path, { recursive: true, force: true })
      stats.deletedDirs += 1
      stats.removed.push(callDir.path)
    }
  }

  return stats
}

export async function pruneArtifacts({
  cwd,
  artifactRoot,
  keepLast = 20,
  rawOnly = false,
  olderThan,
}) {
  const normalizedKeepLast = Number.parseInt(String(keepLast), 10)
  if (!Number.isFinite(normalizedKeepLast) || normalizedKeepLast < 0) {
    throw new Error(`Invalid keep-last value "${keepLast}". Use a non-negative integer.`)
  }

  const olderThanMs = parseOlderThan(olderThan)
  const cutoffMs = olderThanMs === null ? null : Date.now() - olderThanMs
  const rootDir = resolveArtifactRoot(cwd, artifactRoot)

  const [headless, live] = await Promise.all([
    pruneHeadlessSessions({
      rootDir,
      keepLast: normalizedKeepLast,
      rawOnly,
      cutoffMs,
    }),
    pruneLiveSessions({
      cwd,
      rootDir,
      keepLast: normalizedKeepLast,
      rawOnly,
      cutoffMs,
    }),
  ])

  const opencodeLiveDir = path.join(rootDir, "opencode-live")
  const gitignorePresent = await pathExists(path.join(path.resolve(cwd), ".gitignore"))

  return {
    rootDir,
    keepLast: normalizedKeepLast,
    rawOnly,
    olderThan: olderThan ?? null,
    olderThanMs,
    continuityPreserved: {
      liveState: path.join(rootDir, "live", "state"),
      liveStatus: path.join(rootDir, "live", "status"),
      lastLaunch: path.join(rootDir, "live", "last-launch.json"),
      knowledge: path.join(rootDir, "knowledge", "executions.jsonl"),
      liveConfig: opencodeLiveDir,
    },
    repoHygiene: {
      rootGitignorePresent: gitignorePresent,
    },
    headless,
    live,
  }
}
