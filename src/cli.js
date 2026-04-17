import path from "node:path"
import { parseArgs } from "node:util"
import { runOrchestration } from "./lib/orchestrator.js"
import { getGeminiCommandSpec, runGeminiPassthrough } from "./lib/gemini-adapter.js"
import { listLiveSessions, runLiveSession } from "./lib/live-session.js"
import { getOpencodeCommandSpec, runOpencodePassthrough } from "./lib/opencode-adapter.js"
import { pruneArtifacts } from "./lib/prune.js"
import { runSessionsTui } from "./lib/sessions-tui.js"

function help() {
  return [
    "custcli",
    "",
    "Commands:",
    "  run [prompt...]        Plan with Gemini, then execute with OpenCode",
    "  plan [prompt...]       Plan with Gemini only",
    "  live [prompt...]       Open a live OpenCode TUI session with Gemini planning/review tools",
    "  sessions               List known custcli live sessions",
    "  prune                  Prune old raw artifacts and stale live metadata",
    "  gemini -- [args...]    Pass arguments directly to the configured Gemini CLI",
    "  opencode -- [args...]  Pass arguments directly to the configured OpenCode CLI",
    "",
    "Options for run/plan/live:",
    "  --cwd <path>                 Workspace to operate in",
    "  --planner-model <id>         Gemini model override (`auto` leaves Gemini unpinned)",
    "  --planner-mode <mode>        Live planner policy: `free` (default) or `strict`",
    "  --planner-session <id>       Resume a prior Gemini planner session",
    "  --worker-model <id>          OpenCode model override",
    "  --worker-agent <name>        OpenCode agent override",
    "  --worker-variant <name>      OpenCode model variant override",
    "  --planner-approval-mode <m>  Planner approval mode (default: plan)",
    "  --artifact-root <path>       Override artifact root (default: <cwd>/.custcli)",
    "  --open-ui                    Alias: run interactively in the OpenCode TUI",
    "  --continue                   Continue the last OpenCode TUI session",
    "  --session <id>               Continue a specific OpenCode TUI session",
    "  --new-session                Force a brand new OpenCode TUI session",
    "  --fork                       Fork the continued OpenCode session",
    "  --skip-worker                Stop after planning",
    "  --manual-approve             Do not auto-approve OpenCode permissions",
    "  --json                       Print final summary JSON to stdout",
    "  --quiet                      Suppress progress logs on stderr",
    "  -h, --help                   Show help",
    "",
    "Options for sessions:",
    "  --cwd <path>                 Workspace whose artifact root should be inspected",
    "  --artifact-root <path>       Override artifact root (default: <cwd>/.custcli)",
    "  --tui                        Force the interactive sessions picker",
    "  --plain                      Print the text list instead of opening the picker",
    "  --all                        Include stale local custcli metadata even if the OpenCode session is gone",
    "  --json                       Print session data as JSON",
    "  -h, --help                   Show help",
    "",
    "Options for prune:",
    "  --cwd <path>                 Workspace whose artifact root should be pruned",
    "  --artifact-root <path>       Override artifact root (default: <cwd>/.custcli)",
    "  --keep-last <n>              Keep the newest N run/call histories fully intact (default: 20)",
    "  --raw-only                   Remove raw/heavy files only; keep full structured plan/review files",
    "  --older-than <age>           Only prune entries older than this age, like 30m, 12h, 7d, or 2w",
    "  --json                       Print prune summary as JSON",
    "  -h, --help                   Show help",
    "",
    "Environment overrides:",
    '  CUSTCLI_GEMINI_CMD_JSON   JSON array command spec for Gemini, eg: ["node","mock.js"]',
    "  CUSTCLI_GEMINI_BIN        Gemini executable path when CMD_JSON is not set",
    "  CUSTCLI_GEMINI_TIMEOUT_MS Idle timeout for headless Gemini calls; resets whenever Gemini emits output (`0` disables it)",
    "  CUSTCLI_GEMINI_SANDBOX    Enable Gemini CLI sandboxing for custcli planner calls (`0` disables it)",
    "  CUSTCLI_REASONING_PROVIDER Planner/reviewer backend provider (default: gemini)",
    "  CUSTCLI_OPENCODE_CMD_JSON JSON array command spec for OpenCode",
    "  CUSTCLI_OPENCODE_BIN      OpenCode executable path when CMD_JSON is not set",
    "  CUSTCLI_SESSION_DIR       Artifact root override",
  ].join("\n")
}

function getInvocationCwd(env = process.env) {
  const initCwd = String(env.INIT_CWD ?? "").trim()
  return path.resolve(initCwd || process.cwd())
}

async function readPrompt(positionals) {
  let prompt = positionals.join(" ").trim()
  if (!process.stdin.isTTY) {
    const stdinText = await new Promise((resolve, reject) => {
      let data = ""
      process.stdin.setEncoding("utf8")
      process.stdin.on("data", (chunk) => {
        data += chunk
      })
      process.stdin.on("end", () => resolve(data))
      process.stdin.on("error", reject)
    })
    prompt = [prompt, String(stdinText).trim()].filter(Boolean).join("\n\n")
  }
  return prompt.trim()
}

function parseCommand(rawArgs) {
  const first = rawArgs[0]
  if (!first || first.startsWith("-")) {
    return { command: "run", args: rawArgs }
  }
  return { command: first, args: rawArgs.slice(1) }
}

function stripPassthroughSentinel(args) {
  return args[0] === "--" ? args.slice(1) : args
}

function parseRunLikeArgs(args) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      "planner-model": { type: "string" },
      "planner-mode": { type: "string" },
      "planner-session": { type: "string" },
      "worker-model": { type: "string" },
      "worker-agent": { type: "string" },
      "worker-variant": { type: "string" },
      "planner-approval-mode": { type: "string" },
      "artifact-root": { type: "string" },
      "open-ui": { type: "boolean", default: false },
      continue: { type: "boolean", default: false },
      session: { type: "string" },
      "new-session": { type: "boolean", default: false },
      fork: { type: "boolean", default: false },
      "skip-worker": { type: "boolean", default: false },
      "manual-approve": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
}

function parseSessionsArgs(args) {
  return parseArgs({
    args,
    allowPositionals: false,
    options: {
      cwd: { type: "string" },
      "artifact-root": { type: "string" },
      tui: { type: "boolean", default: false },
      plain: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
}

function parsePruneArgs(args) {
  return parseArgs({
    args,
    allowPositionals: false,
    options: {
      cwd: { type: "string" },
      "artifact-root": { type: "string" },
      "keep-last": { type: "string" },
      "raw-only": { type: "boolean", default: false },
      "older-than": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
}

function normalizePlannerModel(value) {
  const normalized = String(value ?? "").trim()
  if (!normalized) return undefined
  if (normalized === "auto") return undefined
  return normalized
}

function normalizePlannerMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!normalized) return "free"
  if (normalized === "free" || normalized === "strict") return normalized
  throw new Error(`Unsupported planner mode "${value}". Use "free" or "strict".`)
}

export async function main(rawArgs = process.argv.slice(2)) {
  const { command, args } = parseCommand(rawArgs)

  if (command === "help") {
    process.stdout.write(`${help()}\n`)
    return
  }

  if (command === "gemini") {
    const spec = getGeminiCommandSpec()
    await runGeminiPassthrough({
      args: stripPassthroughSentinel(args),
      cwd: getInvocationCwd(),
      commandSpec: spec,
    })
    return
  }

  if (command === "opencode") {
    const spec = getOpencodeCommandSpec()
    await runOpencodePassthrough({
      args: stripPassthroughSentinel(args),
      cwd: getInvocationCwd(),
      commandSpec: spec,
    })
    return
  }

  if (command === "sessions") {
    const parsed = parseSessionsArgs(args)
    if (parsed.values.help) {
      process.stdout.write(`${help()}\n`)
      return
    }

    const cwd = path.resolve(parsed.values.cwd ?? getInvocationCwd())
    const wantsTui =
      !parsed.values.json &&
      !parsed.values.plain &&
      (parsed.values.tui || (process.stdin.isTTY && process.stdout.isTTY))

    if (wantsTui) {
      await runSessionsTui({
        cwd,
        artifactRoot: parsed.values["artifact-root"],
      })
      return
    }

    const result = await listLiveSessions({
      cwd,
      artifactRoot: parsed.values["artifact-root"],
      includeStale: Boolean(parsed.values.all),
    })

    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    if (!result.sessions.length) {
      process.stdout.write(`No known custcli live sessions found in ${result.rootDir}\n`)
      return
    }

    const lines = [
      `Known custcli live sessions: ${result.sessions.length}`,
      `Artifact root: ${result.rootDir}`,
    ]
    if (result.sessionValidation.available && result.sessionValidation.hiddenStaleCount > 0) {
      lines.push(`Hidden stale local records: ${result.sessionValidation.hiddenStaleCount} (use --all to include them)`)
    }
    if (!result.sessionValidation.available && result.sessionValidation.error) {
      lines.push(`Session validation unavailable: ${result.sessionValidation.error}`)
      lines.push("Showing local custcli metadata only.")
    }

    for (const item of result.sessions) {
      lines.push("")
      lines.push(`${item.sessionId} (${item.phase})`)
      lines.push(`  Name: ${item.name}`)
      lines.push(`  Workspace: ${item.workspaceRoot ?? "unknown"}`)
      lines.push(`  Gemini Session: ${item.geminiSessionId ?? "none"}`)
      lines.push(`  Activity: plan=${item.planCount} review=${item.reviewCount} raw=${item.rawCount}`)
      lines.push(`  Last Updated: ${item.updatedAt ?? "unknown"}`)
      lines.push(`  Artifact: ${item.artifactDir ?? "none"}`)
      if (item.requestPreview) lines.push(`  Preview: ${item.requestPreview}`)
      lines.push(`  Continue: ${item.continueCommand}`)
    }

    process.stdout.write(`${lines.join("\n")}\n`)
    return
  }

  if (command === "prune") {
    const parsed = parsePruneArgs(args)
    if (parsed.values.help) {
      process.stdout.write(`${help()}\n`)
      return
    }

    const cwd = path.resolve(parsed.values.cwd ?? getInvocationCwd())
    const result = await pruneArtifacts({
      cwd,
      artifactRoot: parsed.values["artifact-root"],
      keepLast: parsed.values["keep-last"] ?? 20,
      rawOnly: Boolean(parsed.values["raw-only"]),
      olderThan: parsed.values["older-than"],
    })

    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    const lines = [
      `Pruned artifact root: ${result.rootDir}`,
      `Keep last: ${result.keepLast}`,
      `Mode: ${result.rawOnly ? "raw-only" : "full retention cleanup"}`,
      `Older than: ${result.olderThan ?? "any age beyond keep-last"}`,
      "",
      "Continuity preserved:",
      `  live state: ${result.continuityPreserved.liveState}`,
      `  live status: ${result.continuityPreserved.liveStatus}`,
      `  last launch: ${result.continuityPreserved.lastLaunch}`,
      `  knowledge: ${result.continuityPreserved.knowledge}`,
      "",
      `Headless runs touched: ${result.headless.touchedRuns}`,
      `Headless files removed: ${result.headless.deletedFiles}`,
      `Live stale sessions removed: ${result.live.staleSessionsRemoved}`,
      `Live stale sessions skipped: ${result.live.staleSessionsSkipped}`,
      `Live files removed: ${result.live.deletedFiles}`,
      `Live directories removed: ${result.live.deletedDirs}`,
    ]

    if (!result.live.sessionValidation.available && result.live.sessionValidation.error) {
      lines.push(`Live validation unavailable: ${result.live.sessionValidation.error}`)
    }

    process.stdout.write(`${lines.join("\n")}\n`)
    return
  }

  if (command !== "run" && command !== "plan" && command !== "live") {
    throw new Error(`Unknown command "${command}". Use --help to see available commands.`)
  }

  const parsed = parseRunLikeArgs(args)
  if (parsed.values.help) {
    process.stdout.write(`${help()}\n`)
    return
  }

  const cwd = path.resolve(parsed.values.cwd ?? getInvocationCwd())
  const prompt = await readPrompt(parsed.positionals)
  const isLiveMode = command === "live" || Boolean(parsed.values["open-ui"])
  const plannerModel = normalizePlannerModel(parsed.values["planner-model"])
  const plannerMode = normalizePlannerMode(parsed.values["planner-mode"])

  if (isLiveMode && command === "plan") {
    throw new Error(`"--open-ui" is not supported with "plan". Use "live" or "run --open-ui" instead.`)
  }

  if (isLiveMode && parsed.values.json) {
    throw new Error('"--json" is not supported in live mode.')
  }

  if (isLiveMode && parsed.values["skip-worker"]) {
    throw new Error('"--skip-worker" is not supported in live mode.')
  }

  if (!prompt && !isLiveMode) {
    throw new Error(`"${command}" requires a prompt. Pass it as arguments or via stdin.`)
  }

  if (isLiveMode) {
    await runLiveSession({
      cwd,
      prompt: prompt || undefined,
      plannerModel,
      plannerMode,
      workerModel: parsed.values["worker-model"],
      workerAgent: parsed.values["worker-agent"],
      plannerApprovalMode: parsed.values["planner-approval-mode"] ?? "plan",
      artifactRoot: parsed.values["artifact-root"],
      continueSession: Boolean(parsed.values.continue),
      session: parsed.values.session,
      newSession: Boolean(parsed.values["new-session"]),
      fork: Boolean(parsed.values.fork),
    })
    return
  }

  const result = await runOrchestration({
    mode: command,
    userPrompt: prompt,
    cwd,
    plannerModel,
    plannerSession: parsed.values["planner-session"],
    workerModel: parsed.values["worker-model"],
    workerAgent: parsed.values["worker-agent"],
    workerVariant: parsed.values["worker-variant"],
    plannerApprovalMode: parsed.values["planner-approval-mode"] ?? "plan",
    artifactRoot: parsed.values["artifact-root"],
    skipWorker: Boolean(parsed.values["skip-worker"]) || command === "plan",
    workerAutoApprove: !parsed.values["manual-approve"],
    outputJson: Boolean(parsed.values.json),
    quiet: Boolean(parsed.values.quiet),
  })

  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`)
    return
  }

  const lines = [
    `Run ID: ${result.summary.runId}`,
    `Artifacts: ${result.summary.artifactDir}`,
    `Planner Session: ${result.summary.plannerSessionId ?? "not returned"}`,
    `Plan Goal: ${result.summary.goal}`,
    `Worker Status: ${result.summary.worker?.status ?? "skipped"}`,
    `Review Verdict: ${result.summary.review?.verdict ?? "not run"}`,
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
}
