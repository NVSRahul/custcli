export function safeSegment(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "unknown"
}

function clipLine(text, limit = 120) {
  const value = String(text || "").replace(/\s+/g, " ").trim()
  if (!value) return ""
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function formatDuration(ms) {
  if (!(Number.isFinite(ms) && ms >= 0)) return null
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

function statusTimestamp(record) {
  return Math.max(Number(record?.updatedAt) || 0, Number(record?.lastActivityAt) || 0, Number(record?.startedAt) || 0, 0)
}

export function pickGeminiStatus({ sessionID, workspaceRoot, entries }) {
  const list = Array.isArray(entries) ? entries.filter((item) => item && typeof item === "object") : []
  const exact = list.find((item) => String(item.sessionID || "") === String(sessionID || ""))
  if (exact) return { record: exact, source: "session" }

  const workspace = list
    .filter((item) => workspaceRoot && String(item.workspaceRoot || "") === String(workspaceRoot))
    .sort((a, b) => statusTimestamp(b) - statusTimestamp(a))
  if (workspace[0]) return { record: workspace[0], source: "workspace" }

  const recent = [...list].sort((a, b) => statusTimestamp(b) - statusTimestamp(a))[0]
  if (recent) return { record: recent, source: "recent" }

  return { record: null, source: "none" }
}

export function buildGeminiSidebarState({ record, source, now = Date.now() }) {
  if (!record) {
    return {
      label: "Idle",
      status: "idle",
      summary: "No Gemini activity yet.",
      detail: "Gemini planning, review, and raw CLI activity will appear here.",
      model: "",
      duration: null,
      source,
    }
  }

  const status = record.phase === "error" ? "error" : record.phase === "completed" ? "completed" : "running"
  const startedAt = typeof record.startedAt === "number" ? record.startedAt : undefined
  const finishedAt =
    status === "completed" || status === "error"
      ? typeof record.updatedAt === "number"
        ? record.updatedAt
        : now
      : now

  const summary =
    clipLine(record.summary) ||
    clipLine(record.statusText) ||
    clipLine(record.stderrPreview) ||
    clipLine(record.stdoutPreview)

  const detail =
    clipLine(record.fallbackNote) ||
    clipLine(record.error) ||
    (source === "workspace"
      ? "Showing latest workspace Gemini activity."
      : source === "recent"
        ? "Showing latest Gemini activity in this workspace."
        : clipLine(record.requestPreview))

  return {
    label: record.kind === "plan" ? "Planning" : record.kind === "review" ? "Reviewing" : "Gemini CLI",
    status,
    summary,
    detail,
    model: clipLine(record.resolvedModel || record.requestedModel || "", 40),
    duration: formatDuration(startedAt ? finishedAt - startedAt : null),
    source,
  }
}
