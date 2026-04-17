import readline from "node:readline"
import { listLiveSessions, removeStaleLiveSession, runLiveSession } from "./live-session.js"

const ANSI = {
  enterAlt: "\u001b[?1049h\u001b[?25l",
  exitAlt: "\u001b[?1049l\u001b[?25h",
  clear: "\u001b[2J\u001b[H",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  gray: "\u001b[90m",
  inverse: "\u001b[7m",
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
}

function visibleLength(text) {
  return stripAnsi(text).length
}

function truncate(text, width) {
  const value = String(text ?? "")
  if (width <= 0) return ""
  if (visibleLength(value) <= width) return value
  const plain = stripAnsi(value)
  if (width <= 1) return plain.slice(0, width)
  return `${plain.slice(0, width - 1)}…`
}

function pad(text, width) {
  const clipped = truncate(text, width)
  const extra = Math.max(0, width - visibleLength(clipped))
  return `${clipped}${" ".repeat(extra)}`
}

function wrap(text, width) {
  const source = String(text ?? "").trim()
  if (!source || width <= 0) return [""]
  const words = source.split(/\s+/)
  const lines = []
  let current = ""

  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`
      continue
    }
    lines.push(current)
    current = word
  }

  if (current) lines.push(current)
  return lines
}

function divider(width) {
  return `${ANSI.gray}${"─".repeat(Math.max(0, width))}${ANSI.reset}`
}

function formatWhen(value) {
  if (!value) return "unknown"
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

function phaseLabel(item) {
  if (item.stale) return `${ANSI.red}stale${ANSI.reset}`
  if (item.phase === "running") return `${ANSI.yellow}running${ANSI.reset}`
  if (item.phase === "completed") return `${ANSI.green}done${ANSI.reset}`
  return `${ANSI.gray}${item.phase}${ANSI.reset}`
}

function validationText(result) {
  if (result.sessionValidation.available) {
    if (result.sessionValidation.hiddenStaleCount > 0) {
      return `${ANSI.yellow}${result.sessionValidation.hiddenStaleCount} stale hidden${ANSI.reset}`
    }
    return `${ANSI.green}validated${ANSI.reset}`
  }
  return `${ANSI.red}local-only${ANSI.reset}`
}

function renderListItem(item, selected, width) {
  const marker = selected ? `${ANSI.cyan}›${ANSI.reset}` : " "
  const status = item.stale ? `${ANSI.red}×${ANSI.reset}` : item.phase === "running" ? `${ANSI.yellow}●${ANSI.reset}` : `${ANSI.green}●${ANSI.reset}`
  const session = `${ANSI.gray}${item.sessionId}${ANSI.reset}`
  const line = `${marker} ${status} ${item.name}`
  const meta = `${item.updatedAt ? formatWhen(item.updatedAt) : "unknown"}`
  const top = pad(line, Math.max(8, width - 1))
  const bottom = pad(`${session}  ${meta}`, Math.max(8, width - 1))
  return [top, bottom]
}

function renderDetailLines(item, result, width) {
  if (!item) {
    return [
      `${ANSI.bold}No sessions${ANSI.reset}`,
      "",
      "There are no sessions to show in this artifact root.",
    ]
  }

  const lines = [
    `${ANSI.bold}${item.name}${ANSI.reset}`,
    `${ANSI.dim}${item.sessionId}${ANSI.reset}`,
    "",
    `Phase: ${phaseLabel(item)}`,
    `Workspace: ${item.workspaceRoot ?? "unknown"}`,
    `Gemini session: ${item.geminiSessionId ?? "none"}`,
    `Activity: plan=${item.planCount} review=${item.reviewCount} raw=${item.rawCount}`,
    `Updated: ${formatWhen(item.updatedAt)}`,
    `Artifact: ${item.artifactDir ?? "none"}`,
    "",
    `${ANSI.bold}Continue${ANSI.reset}`,
    item.continueCommand,
    "",
  ]

  if (item.requestPreview) {
    lines.push(`${ANSI.bold}Preview${ANSI.reset}`)
    lines.push(...wrap(item.requestPreview, width))
    lines.push("")
  }

  lines.push(`${ANSI.bold}Keys${ANSI.reset}`)
  lines.push("Enter open selected session")
  lines.push("↑/↓ or j/k move")
  lines.push("r refresh")
  lines.push("a toggle stale")
  if (result.sessionValidation.available) {
    lines.push("d delete selected stale local metadata")
  } else {
    lines.push("d disabled until session validation works")
  }
  lines.push("Esc/q close")

  return lines.flatMap((line) => wrap(line, width))
}

function buildScreen({ result, selectedIndex, includeStale, message }) {
  const width = process.stdout.columns || 120
  const height = process.stdout.rows || 30
  const listWidth = Math.max(36, Math.min(60, Math.floor(width * 0.44)))
  const detailWidth = Math.max(24, width - listWidth - 3)
  const left = []
  const selected = result.sessions[selectedIndex] ?? null

  left.push(`${ANSI.bold}custcli sessions${ANSI.reset}`)
  left.push(`root: ${result.rootDir}`)
  left.push(`mode: ${includeStale ? "all" : "active only"}  validation: ${validationText(result)}`)
  left.push(divider(listWidth))

  if (!result.sessions.length) {
    left.push("No sessions found.")
  } else {
    for (const [index, item] of result.sessions.entries()) {
      const rendered = renderListItem(item, index === selectedIndex, listWidth)
      left.push(...rendered)
      left.push("")
    }
  }

  const right = renderDetailLines(selected, result, detailWidth)
  const maxLines = Math.max(left.length, right.length)
  const rows = []
  for (let i = 0; i < Math.min(maxLines, Math.max(10, height - 2)); i += 1) {
    const lhs = pad(left[i] ?? "", listWidth)
    const rhs = right[i] ?? ""
    rows.push(`${lhs} ${ANSI.gray}│${ANSI.reset} ${truncate(rhs, detailWidth)}`)
  }

  const footerParts = [
    "Enter open",
    "r refresh",
    "a stale",
    "d delete stale",
    "Esc close",
  ]
  if (message) footerParts.push(`${ANSI.cyan}${message}${ANSI.reset}`)

  return `${ANSI.hideCursor}${ANSI.clear}${rows.join("\n")}\n${divider(width)}\n${truncate(footerParts.join("  ·  "), width)}`
}

export async function runSessionsTui({ cwd, artifactRoot }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The sessions TUI requires an interactive terminal. Use "custcli sessions --plain" or "--json" instead.')
  }

  readline.emitKeypressEvents(process.stdin)
  const previousRawMode = process.stdin.isRaw
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdout.write(ANSI.enterAlt)

  let includeStale = false
  let result = await listLiveSessions({ cwd, artifactRoot, includeStale })
  let selectedIndex = 0
  let message = "Press Enter to open the selected session."
  let closed = false

  const refresh = async (nextMessage) => {
    result = await listLiveSessions({ cwd, artifactRoot, includeStale })
    if (selectedIndex >= result.sessions.length) selectedIndex = Math.max(0, result.sessions.length - 1)
    message = nextMessage ?? message
    process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    process.stdout.write(`${ANSI.clear}${ANSI.exitAlt}${ANSI.reset}`)
    process.stdin.setRawMode?.(previousRawMode ?? false)
    process.stdin.pause()
    process.stdin.removeListener("keypress", onKeypress)
    process.stdout.removeListener("resize", onResize)
  }

  const closeAndRun = async (session) => {
    cleanup()
    await runLiveSession({
      cwd: session.workspaceRoot ?? cwd,
      artifactRoot: result.rootDir,
      session: session.sessionId,
    })
  }

  const onResize = () => {
    process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
  }

  const onKeypress = async (_str, key = {}) => {
    if (closed) return

    if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
      cleanup()
      return
    }

    if (!result.sessions.length) {
      if (key.name === "a") {
        includeStale = !includeStale
        await refresh(includeStale ? "Showing all local metadata, including stale entries." : "Showing only active validated sessions.")
      }
      if (key.name === "r") await refresh("Refreshed sessions.")
      return
    }

    if (key.name === "down" || key.name === "j") {
      selectedIndex = Math.min(result.sessions.length - 1, selectedIndex + 1)
      process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
      return
    }

    if (key.name === "up" || key.name === "k") {
      selectedIndex = Math.max(0, selectedIndex - 1)
      process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
      return
    }

    if (key.name === "a") {
      includeStale = !includeStale
      await refresh(includeStale ? "Showing all local metadata, including stale entries." : "Showing only active validated sessions.")
      return
    }

    if (key.name === "r") {
      await refresh("Refreshed sessions.")
      return
    }

    const selected = result.sessions[selectedIndex]

    if (key.name === "return") {
      if (!selected.workspaceRoot) {
        message = "Cannot open this session because the workspace is unknown."
        process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
        return
      }
      if (result.sessionValidation.available && selected.stale) {
        message = "This session is stale. Press d to remove the local metadata or a to hide stale entries."
        process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
        return
      }
      await closeAndRun(selected)
      return
    }

    if (key.name === "d") {
      if (!result.sessionValidation.available) {
        message = "Delete is disabled until OpenCode session validation is available."
        process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
        return
      }
      if (!selected.stale) {
        message = "Delete only removes stale local metadata for sessions that no longer exist."
        process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
        return
      }
      await removeStaleLiveSession({
        rootDir: result.rootDir,
        sessionId: selected.sessionId,
        knownStale: true,
      })
      await refresh(`Deleted stale local metadata for ${selected.sessionId}.`)
    }
  }

  process.stdin.on("keypress", onKeypress)
  process.stdout.on("resize", onResize)
  process.stdout.write(buildScreen({ result, selectedIndex, includeStale, message }))
}
