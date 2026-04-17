import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
const configDir = path.resolve(runtimeDir, "..")
const artifactRoot = path.resolve(configDir, "..")
const settingsPath = path.join(runtimeDir, "settings.json")
const manifestPath = path.join(configDir, "custcli-live.json")
const DEFAULT_GEMINI_TIMEOUT_MS = 180000
const GEMINI_SANDBOX_DISABLED = new Set(["0", "false", "no", "off"])
const GEMINI_UNSAFE_RAW_FLAGS = new Set(["-w", "--worktree"])
const GEMINI_PROGRESS_HEARTBEAT_MS = 1000
const GEMINI_PROGRESS_THROTTLE_MS = 350

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

function createStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-")
}

function safeSegment(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "unknown"
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, value, "utf8")
}

async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8")
}

function geminiStatusPath(sessionID) {
  return path.join(artifactRoot, "live", "status", `${safeSegment(sessionID)}.json`)
}

async function writeGeminiStatus(sessionID, value) {
  await writeJson(geminiStatusPath(sessionID), value)
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
}

let cachedSettings
let cachedManifest
async function loadSettings() {
  if (cachedSettings) return cachedSettings

  try {
    const raw = await fs.readFile(settingsPath, "utf8")
    cachedSettings = JSON.parse(raw)
  } catch {
    cachedSettings = {
      defaultPlannerModel: null,
      defaultApprovalMode: "plan",
      geminiTimeoutMs: DEFAULT_GEMINI_TIMEOUT_MS,
      geminiSandbox: true,
    }
  }

  return cachedSettings
}

async function loadManifest() {
  if (cachedManifest) return cachedManifest

  try {
    const raw = await fs.readFile(manifestPath, "utf8")
    cachedManifest = JSON.parse(raw)
  } catch {
    cachedManifest = {}
  }

  return cachedManifest
}

function isFilesystemRoot(value) {
  const resolved = path.resolve(String(value || ""))
  return path.parse(resolved).root === resolved
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function sanitizeWorkspaceContext(workspaceContext, cwd) {
  const value = String(workspaceContext || "").trim()
  if (!value) return ""

  return value
    .split("\n")
    .map((line) => {
      const workspaceRootMatch = line.match(/^(\s*Workspace root folder:\s*)(.+)$/i)
      if (workspaceRootMatch) {
        const candidate = path.resolve(workspaceRootMatch[2].trim())
        if (isFilesystemRoot(candidate) || !isWithinRoot(cwd, candidate)) {
          return `${workspaceRootMatch[1]}${cwd}`
        }
      }

      const workingDirectoryMatch = line.match(/^(\s*Working directory:\s*)(.+)$/i)
      if (workingDirectoryMatch) {
        const candidate = path.resolve(workingDirectoryMatch[2].trim())
        if (!isWithinRoot(cwd, candidate)) {
          return `${workingDirectoryMatch[1]}${cwd}`
        }
      }

      return line
    })
    .join("\n")
}

function parseCommandSpec({ env, jsonKey, binKey, fallback }) {
  const json = env[jsonKey]
  if (json) {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`${jsonKey} must be a non-empty JSON array of strings`)
    }
    return parsed
  }

  const binary = env[binKey]
  if (binary) return [binary]
  return fallback
}

function getGeminiCommandSpec(env = process.env) {
  return parseCommandSpec({
    env,
    jsonKey: "CUSTCLI_GEMINI_CMD_JSON",
    binKey: "CUSTCLI_GEMINI_BIN",
    fallback: ["gemini"],
  })
}

function splitCommandSpec(commandSpec) {
  const [command, ...baseArgs] = commandSpec
  if (!command) throw new Error("Command spec must contain at least one element")
  return { command, baseArgs }
}

async function runCommand({ commandSpec, args = [], cwd, input, env = process.env, timeoutMs, onStdout, onStderr }) {
  const { command, baseArgs } = splitCommandSpec(commandSpec)
  const child = spawn(command, [...baseArgs, ...args], {
    cwd,
    env,
    stdio: "pipe",
  })

  let stdout = ""
  let stderr = ""
  let timedOut = false
  let timeoutHandle
  let forceKillHandle

  const clearKillTimers = () => {
    clearTimeout(timeoutHandle)
    clearTimeout(forceKillHandle)
  }

  const scheduleTimeout = () => {
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return
    clearKillTimers()
    timeoutHandle = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGTERM")
      } catch {
      }
      forceKillHandle = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
        }
      }, 1000)
      forceKillHandle.unref?.()
    }, timeoutMs)
    timeoutHandle.unref?.()
  }

  if (child.stdout) {
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      scheduleTimeout()
      try {
        onStdout?.(chunk)
      } catch {
      }
    })
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      scheduleTimeout()
      try {
        onStderr?.(chunk)
      } catch {
      }
    })
  }

  const exit = new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code, signal) => resolve({ code, signal }))
  })

  scheduleTimeout()

  if (child.stdin) {
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
  }

  const { code, signal } = await exit
  clearKillTimers()
  return {
    code: code ?? 0,
    signal,
    stdout,
    stderr,
    timedOut,
    ok: code === 0,
  }
}

function extractEnvelope(text) {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("Gemini returned empty output.")
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new Error("Gemini did not return a valid JSON envelope.")
  }
}

function clipText(text, limit = 12000) {
  const value = String(text || "")
  if (value.length <= limit) return value
  const omitted = value.length - limit
  return `${value.slice(0, limit)}\n\n[output truncated, omitted ${omitted} characters]`
}

function clipInlineText(text, limit = 220) {
  const value = String(text || "").replace(/\s+/g, " ").trim()
  if (!value) return ""
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function lastNonEmptyLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || ""
}

function emitToolMetadata(context, title, metadata) {
  try {
    context.metadata({
      title,
      metadata,
    })
  } catch {
  }
}

function createGeminiProgressReporter({ context, title, kind, cwd, requestPreview, requestedModel }) {
  const startedAt = Date.now()
  let updatedAt = startedAt
  let lastActivityAt = startedAt
  let lastEmitAt = 0
  let statusText = "Launching Gemini..."
  let stdoutPreview = ""
  let stderrPreview = ""
  let resolvedModel = requestedModel ?? null
  let heartbeat
  let statusWrite = Promise.resolve()

  const snapshot = (phase, extra = {}) => ({
    gemini: {
      kind,
      phase,
      title,
      requestPreview,
      statusText,
      stdoutPreview,
      stderrPreview,
      requestedModel: requestedModel ?? null,
      resolvedModel,
      workspaceRoot: cwd,
      startedAt,
      updatedAt,
      lastActivityAt,
      elapsedMs: updatedAt - startedAt,
      ...extra,
    },
  })

  const emit = (phase, extra = {}, options = {}) => {
    const now = Date.now()
    if (!options.force && now - lastEmitAt < GEMINI_PROGRESS_THROTTLE_MS) return
    updatedAt = now
    lastEmitAt = now
    const payload = snapshot(phase, extra)
    emitToolMetadata(context, title, payload)
    statusWrite = statusWrite
      .catch(() => {})
      .then(() =>
        writeGeminiStatus(context.sessionID, {
          sessionID: context.sessionID,
          toolTitle: title,
          ...payload.gemini,
        }),
      )
  }

  const start = () => {
    emit("running", {}, { force: true })
    heartbeat = setInterval(() => {
      emit("running")
    }, GEMINI_PROGRESS_HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  const stop = () => {
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  const appendPreview = (current, chunk, limit = 220) => clipInlineText([current, chunk].filter(Boolean).join(" "), limit)

  return {
    start,
    stop,
    setResolvedModel(value) {
      resolvedModel = value ?? null
    },
    setStatus(next, options) {
      const clipped = clipInlineText(next, 180)
      if (!clipped) return
      statusText = clipped
      emit("running", {}, options)
    },
    onStdout(chunk) {
      lastActivityAt = Date.now()
      stdoutPreview = appendPreview(stdoutPreview, chunk, 260)
      statusText = kind === "raw" ? "Receiving Gemini output..." : "Gemini is returning structured output..."
      emit("running")
    },
    onStderr(chunk) {
      lastActivityAt = Date.now()
      stderrPreview = appendPreview(stderrPreview, chunk, 260)
      const line = lastNonEmptyLine(chunk)
      if (line) statusText = clipInlineText(line, 180)
      emit("running")
    },
    complete(extra = {}) {
      stop()
      emit("completed", extra, { force: true })
    },
    fail(message, extra = {}) {
      stop()
      const clipped = clipInlineText(message, 220)
      if (clipped) statusText = clipped
      emit("error", { error: clipped || "Gemini failed.", ...extra }, { force: true })
    },
    state() {
      return {
        startedAt,
        updatedAt,
        lastActivityAt,
        statusText,
        stdoutPreview,
        stderrPreview,
        requestedModel: requestedModel ?? null,
        resolvedModel,
      }
    },
  }
}

function getGeminiTimeoutMs(settings, env = process.env) {
  const raw = env.CUSTCLI_GEMINI_TIMEOUT_MS ?? settings?.geminiTimeoutMs
  const parsed = Number.parseInt(String(raw ?? ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GEMINI_TIMEOUT_MS
}

function getGeminiSandboxEnabled(settings, env = process.env) {
  const raw = String(env.CUSTCLI_GEMINI_SANDBOX ?? settings?.geminiSandbox ?? "").trim().toLowerCase()
  if (!raw) return true
  return !GEMINI_SANDBOX_DISABLED.has(raw)
}

function buildWorkspaceScopedGeminiArgs({ cwd, sandboxEnabled }) {
  const args = ["--include-directories", cwd]
  if (sandboxEnabled) args.push("--sandbox")
  return args
}

function sanitizeRawGeminiArgs(args) {
  const sanitized: string[] = []
  let skipNext = false

  for (const arg of args) {
    if (skipNext) {
      skipNext = false
      continue
    }

    if (GEMINI_UNSAFE_RAW_FLAGS.has(arg) || [...GEMINI_UNSAFE_RAW_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) {
      throw new Error(
        'custcli raw Gemini calls do not allow "--worktree"; start Gemini from the intended workspace instead.',
      )
    }

    if (arg === "--include-directories") {
      skipNext = true
      continue
    }

    if (arg.startsWith("--include-directories=")) {
      continue
    }

    sanitized.push(arg)
  }

  return sanitized
}

function isGeminiAuthIssue(text) {
  return /manual authorization is required|authentication process|failed to sign in|sign in with google|google login|choose your authentication method|oauth/i.test(
    text,
  )
}

function isGeminiNonInteractiveApprovalIssue(text) {
  return /requires user confirmation|not supported in non-interactive mode|current session is non-interactive/i.test(
    text,
  )
}

function isGeminiModelNotFound(text) {
  return /modelnotfounderror|requested entity was not found/i.test(text)
}

function isGeminiCapacityIssue(text) {
  return /model_capacity_exhausted|resource_exhausted|no capacity available for model|ratelimitexceeded/i.test(text)
}

function formatGeminiFailure({ result, args, timeoutMs }) {
  const combinedOutput = [result.stderr, result.stdout].filter(Boolean).join("\n").trim()
  const guidance =
    "Run `gemini` once in a normal terminal to finish sign-in, or configure `GEMINI_API_KEY` / Vertex AI environment variables, then retry."
  const snippet = clipText(combinedOutput || "(empty)", 1200)

  if (result.timedOut) {
    return [
      `Gemini planner went quiet for ${timeoutMs}ms.`,
      "Likely cause: Gemini is waiting on authentication, another interactive confirmation, backend capacity, or stopped producing output.",
      guidance,
      `Gemini args: ${args.join(" ") || "(none)"}`,
      `Last output snippet: ${snippet}`,
    ].join("\n")
  }

  if (result.code === 41 || isGeminiAuthIssue(combinedOutput)) {
    return [
      "Gemini CLI needs authentication before custcli can use it in headless mode.",
      guidance,
      `Gemini args: ${args.join(" ") || "(none)"}`,
      `Last output snippet: ${snippet}`,
    ].join("\n")
  }

  if (isGeminiNonInteractiveApprovalIssue(combinedOutput)) {
    return [
      "Gemini CLI requested manual confirmation that is not available in custcli headless planner mode.",
      "Use `gemini` directly for that interactive action first, then retry from custcli.",
      `Gemini args: ${args.join(" ") || "(none)"}`,
      `Last output snippet: ${snippet}`,
    ].join("\n")
  }

  return `Gemini failed with code ${result.code}: ${result.stderr || result.stdout}`
}

function stripFence(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return match ? match[1].trim() : text.trim()
}

function extractBalancedJson(text) {
  const source = stripFence(text)
  const start = source.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }
  return null
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (value === undefined || value === null || value === "") return []
  return [String(value).trim()].filter(Boolean)
}

function normalizeSteps(value) {
  const steps = Array.isArray(value) ? value : []
  if (steps.length === 0) {
    return [
      {
        id: "step-1",
        title: "Implement requested work",
        description: "Apply the planned implementation in the current workspace.",
        opencodePrompt: "Implement the requested work in the current workspace.",
        dependsOn: [],
        doneWhen: ["The request is satisfied safely and verified."],
      },
    ]
  }

  return steps.map((step, index) => ({
    id: String(step?.id ?? `step-${index + 1}`),
    title: String(step?.title ?? step?.name ?? `Step ${index + 1}`),
    description: String(step?.description ?? step?.details ?? step?.prompt ?? ""),
    opencodePrompt: String(
      step?.opencodePrompt ??
        step?.worker_prompt ??
        step?.prompt ??
        `Execute "${String(step?.title ?? `Step ${index + 1}`)}" in the current workspace.`,
    ),
    dependsOn: asArray(step?.dependsOn ?? step?.requires),
    doneWhen: asArray(step?.doneWhen ?? step?.success_criteria),
  }))
}

function normalizePlan(plan, rawResponse) {
  const normalized = {
    goal: String(plan?.goal ?? "Complete the requested work"),
    workspaceSummary: String(plan?.workspace_summary ?? plan?.workspaceSummary ?? ""),
    reasoningSummary: String(plan?.reasoning_summary ?? plan?.reasoningSummary ?? ""),
    decisionLog: asArray(plan?.decision_log ?? plan?.decisionLog),
    findings: asArray(plan?.findings),
    assumptions: asArray(plan?.assumptions),
    risks: asArray(plan?.risks),
    executionSteps: normalizeSteps(plan?.execution_steps ?? plan?.executionSteps),
    replanTriggers: asArray(plan?.replan_triggers ?? plan?.replanTriggers),
    successCriteria: asArray(plan?.success_criteria ?? plan?.successCriteria),
    rawResponse,
  }

  if (!normalized.reasoningSummary) {
    normalized.reasoningSummary = normalized.findings[0] ?? "Planner returned a plan without a separate reasoning summary."
  }

  return normalized
}

function extractPlan(responseText) {
  const candidate = extractBalancedJson(responseText)
  if (candidate) {
    try {
      return normalizePlan(JSON.parse(candidate), responseText)
    } catch {
    }
  }

  return normalizePlan(
    {
      goal: "Interpret freeform planner response",
      workspace_summary: "",
      reasoning_summary: responseText.trim().slice(0, 1200),
      decision_log: ["Planner response was not strict JSON, so a fallback plan was created."],
      findings: [],
      assumptions: [],
      risks: ["Planner returned non-JSON output."],
      execution_steps: [
        {
          id: "step-1",
          title: "Implement based on planner notes",
          description: responseText.trim(),
          opencodePrompt: responseText.trim() || "Implement the requested work in the current workspace.",
          dependsOn: [],
          doneWhen: ["Requested work is implemented and verified."],
        },
      ],
      replan_triggers: ["Worker reports ambiguity or plan mismatch."],
      success_criteria: ["Requested work is implemented and verified."],
    },
    responseText,
  )
}

function normalizeReview(review, rawResponse) {
  const normalized = {
    verdict: String(review?.verdict ?? "needs_followup"),
    summary: String(review?.summary ?? review?.reasoning_summary ?? ""),
    findings: asArray(review?.findings),
    risks: asArray(review?.risks),
    followUpSteps: asArray(review?.follow_up_steps ?? review?.followUpSteps),
    tests: asArray(review?.tests ?? review?.test_gaps),
    rawResponse,
  }

  if (!normalized.summary) {
    normalized.summary = normalized.findings[0] ?? "Gemini review returned no summary."
  }

  return normalized
}

function extractReview(responseText) {
  const candidate = extractBalancedJson(responseText)
  if (candidate) {
    try {
      return normalizeReview(JSON.parse(candidate), responseText)
    } catch {
    }
  }

  return normalizeReview(
    {
      verdict: "needs_followup",
      summary: responseText.trim().slice(0, 1200),
      findings: [],
      risks: ["Gemini review returned non-JSON output."],
      follow_up_steps: ["Review the raw Gemini response artifact before concluding."],
      tests: [],
    },
    responseText,
  )
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
}

function overlapScore(a, b) {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  let score = 0
  for (const item of left) {
    if (right.has(item)) score += 1
  }
  return score
}

async function loadRelevantKnowledge({ prompt, cwd, limit = 3 }) {
  const filePath = path.join(artifactRoot, "knowledge", "executions.jsonl")
  const items = await readJsonl(filePath)
  return items
    .map((item) => ({
      ...item,
      score: overlapScore(prompt, [item.prompt, item.goal, item.reasoningSummary].filter(Boolean).join(" ")),
    }))
    .filter((item) => item.cwd === cwd && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

async function appendKnowledgeRecord(record) {
  const filePath = path.join(artifactRoot, "knowledge", "executions.jsonl")
  await appendJsonl(filePath, record)
}

async function workspaceRoot(context) {
  const manifest = await loadManifest()
  const manifestRoot =
    typeof manifest.workspaceRoot === "string" && manifest.workspaceRoot.trim()
      ? path.resolve(manifest.workspaceRoot)
      : null

  const contextRoot =
    typeof context.worktree === "string" && context.worktree.trim()
      ? path.resolve(context.worktree)
      : typeof context.directory === "string" && context.directory.trim()
        ? path.resolve(context.directory)
        : null

  let resolved = contextRoot || manifestRoot || path.resolve(process.cwd())

  if (manifestRoot && !isWithinRoot(manifestRoot, resolved)) {
    resolved = manifestRoot
  }

  if (isFilesystemRoot(resolved)) {
    if (manifestRoot && manifestRoot !== resolved) {
      resolved = manifestRoot
    } else {
      throw new Error(
        "custcli refused to run Gemini with workspace root '/'. Restart the live session from the intended project directory.",
      )
    }
  }

  return resolved
}

function sessionStatePath(sessionID) {
  return path.join(artifactRoot, "live", "state", `${safeSegment(sessionID)}.json`)
}

async function readSessionState(sessionID) {
  try {
    const raw = await fs.readFile(sessionStatePath(sessionID), "utf8")
    return JSON.parse(raw)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        geminiSessionId: null,
        planCount: 0,
        reviewCount: 0,
        rawCount: 0,
      }
    }
    throw error
  }
}

async function writeSessionState(sessionID, value) {
  await writeJson(sessionStatePath(sessionID), value)
}

function callDir(sessionID, kind) {
  return path.join(
    artifactRoot,
    "live",
    "sessions",
    safeSegment(sessionID),
    `${createStamp()}-${kind}-${randomSuffix()}`,
  )
}

function createPlannerPrompt({ userPrompt, cwd, knowledge = [] }) {
  const knowledgeBlock =
    knowledge.length === 0
      ? "No prior local execution lessons were found."
      : knowledge
          .map(
            (item, index) =>
              `${index + 1}. Goal: ${item.goal}\nReasoning summary: ${item.reasoningSummary}\nOutcome: ${item.workerStatus}`,
          )
          .join("\n\n")

  return [
    "You are the sovereign planner for a paired coding system.",
    "Gemini owns planning and codebase analysis. OpenCode will execute the work after you respond.",
    "You may search and analyze as needed, but do not assume hidden reasoning will be available later.",
    "Return strict JSON only. Do not wrap the JSON in markdown fences.",
    "",
    "Your JSON schema:",
    "{",
    '  "goal": "string",',
    '  "workspace_summary": "string",',
    '  "reasoning_summary": "string",',
    '  "decision_log": ["string"],',
    '  "findings": ["string"],',
    '  "assumptions": ["string"],',
    '  "risks": ["string"],',
    '  "execution_steps": [',
    "    {",
    '      "id": "string",',
    '      "title": "string",',
    '      "description": "string",',
    '      "opencodePrompt": "string",',
    '      "dependsOn": ["string"],',
    '      "doneWhen": ["string"]',
    "    }",
    "  ],",
    '  "replan_triggers": ["string"],',
    '  "success_criteria": ["string"]',
    "}",
    "",
    `Workspace root: ${cwd}`,
    "",
    "Prior local execution lessons:",
    knowledgeBlock,
    "",
    "User request:",
    userPrompt,
  ].join("\n")
}

function createReviewPrompt({ request, implementationSummary, changedFiles, testsRun, openQuestions, cwd }) {
  const changed = changedFiles.length ? changedFiles.map((item) => `- ${item}`) : ["- None provided"]
  const tests = testsRun.length ? testsRun.map((item) => `- ${item}`) : ["- None provided"]

  return [
    "You are reviewing work performed by OpenCode in a paired coding workflow.",
    "Assess correctness, regression risk, plan fidelity, and missing validation.",
    "Return strict JSON only. Do not wrap the JSON in markdown fences.",
    "",
    "Your JSON schema:",
    "{",
    '  "verdict": "approved | changes_requested | needs_followup",',
    '  "summary": "string",',
    '  "findings": ["string"],',
    '  "risks": ["string"],',
    '  "follow_up_steps": ["string"],',
    '  "tests": ["string"]',
    "}",
    "",
    `Workspace root: ${cwd}`,
    "",
    "Original request:",
    request,
    "",
    "Implementation summary:",
    implementationSummary,
    "",
    "Changed files:",
    ...changed,
    "",
    "Tests already run:",
    ...tests,
    "",
    "Open questions:",
    openQuestions?.trim() || "None provided",
  ].join("\n")
}

function formatPlanResult({ plan, geminiSessionId, artifactDir, fallbackNote }) {
  const steps = plan.executionSteps
    .slice(0, 3)
    .map((step, index) => `${index + 1}. ${step.title}`)
    .join("\n")

  return [
    `Planner goal: ${plan.goal}`,
    `Planner summary: ${clipInlineText(plan.reasoningSummary || plan.workspaceSummary || plan.goal, 220)}`,
    `Planner session: ${geminiSessionId ?? "not returned"}`,
    `Planner artifacts: ${artifactDir}`,
    ...(fallbackNote ? [`Model note: ${fallbackNote}`] : []),
    "Key findings:",
    ...(plan.findings.length ? plan.findings.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Key risks:",
    ...(plan.risks.length ? plan.risks.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Next steps:",
    steps || "1. Implement requested work",
    "If more detail is needed, inspect plan.json in the planner artifact directory first.",
    "Use this as internal guidance. Do not quote it wholesale to the user.",
  ].join("\n")
}

function formatReviewResult({ review, geminiSessionId, artifactDir, fallbackNote }) {
  return [
    `Verdict: ${review.verdict}`,
    `Review summary: ${clipInlineText(review.summary, 220)}`,
    `Gemini session: ${geminiSessionId ?? "not returned"}`,
    `Review artifacts: ${artifactDir}`,
    ...(fallbackNote ? [`Model note: ${fallbackNote}`] : []),
    "Key findings:",
    ...(review.findings.length ? review.findings.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Key risks:",
    ...(review.risks.length ? review.risks.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Follow-up:",
    ...(review.followUpSteps.length
      ? review.followUpSteps.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`)
      : ["- None recorded"]),
    "If more detail is needed, inspect review.json in the review artifact directory first.",
    "Use this as internal guidance. Do not quote it wholesale to the user.",
  ].join("\n")
}

function formatRawResult({ argv, stdout, stderr, geminiSessionId, artifactDir }) {
  return [
    `Gemini session: ${geminiSessionId ?? "not returned"}`,
    `Raw Gemini artifacts: ${artifactDir}`,
    `Command args: ${argv.join(" ") || "(none)"}`,
    "",
    "STDOUT:",
    clipText(stdout || "(empty)"),
    "",
    "STDERR:",
    clipText(stderr || "(empty)"),
  ].join("\n")
}

async function runGeminiJson({ prompt, cwd, sessionId, model, progress }) {
  const settings = await loadSettings()
  const timeoutMs = getGeminiTimeoutMs(settings)
  const defaultModel = settings.defaultPlannerModel || null
  const workspaceArgs = buildWorkspaceScopedGeminiArgs({
    cwd,
    sandboxEnabled: getGeminiSandboxEnabled(settings),
  })

  const buildArgs = (modelOverride) => {
    const args = ["--approval-mode", settings.defaultApprovalMode || "plan", "--output-format", "json", ...workspaceArgs]
    if (modelOverride) args.push("-m", modelOverride)
    if (sessionId) args.push("--resume", sessionId)
    args.push("-p", prompt)
    return args
  }

  let modelToUse = model || defaultModel
  progress?.setResolvedModel(modelToUse)
  let args = buildArgs(modelToUse)
  let result = await runCommand({
    commandSpec: getGeminiCommandSpec(),
    args,
    cwd,
    timeoutMs,
    onStdout: (chunk) => progress?.onStdout(chunk),
    onStderr: (chunk) => progress?.onStderr(chunk),
  })

  let fallbackNote
  if ((!result.ok || result.timedOut) && modelToUse) {
    const combinedOutput = [result.stderr, result.stdout].filter(Boolean).join("\n")
    if (!result.timedOut && (isGeminiModelNotFound(combinedOutput) || isGeminiCapacityIssue(combinedOutput))) {
      const failedModel = modelToUse
      progress?.setStatus(
        isGeminiModelNotFound(combinedOutput)
          ? `Gemini model "${failedModel}" was unavailable. Retrying automatically...`
          : `Gemini model "${failedModel}" hit capacity limits. Retrying automatically...`,
        { force: true },
      )
      modelToUse = defaultModel
      args = buildArgs(model && defaultModel === model ? undefined : modelToUse)
      if (modelToUse === failedModel) {
        args = buildArgs(undefined)
      }
      progress?.setResolvedModel(modelToUse)
      result = await runCommand({
        commandSpec: getGeminiCommandSpec(),
        args,
        cwd,
        timeoutMs,
        onStdout: (chunk) => progress?.onStdout(chunk),
        onStderr: (chunk) => progress?.onStderr(chunk),
      })
      fallbackNote =
        isGeminiModelNotFound(combinedOutput)
          ? modelToUse && modelToUse !== failedModel
            ? `Gemini model override "${failedModel}" was unavailable, so custcli retried with the configured default planner model "${modelToUse}".`
            : `Gemini model override "${failedModel}" was unavailable, so custcli retried without an explicit model override.`
          : modelToUse && modelToUse !== failedModel
            ? `Gemini model "${failedModel}" hit server capacity limits, so custcli retried with the configured default planner model "${modelToUse}".`
            : `Gemini model "${failedModel}" hit server capacity limits, so custcli retried without an explicit model override.`
    }
  }

  if (!result.ok || result.timedOut) {
    throw new Error(formatGeminiFailure({ result, args, timeoutMs }))
  }

  const envelope = extractEnvelope(result.stdout)
  const responseText =
    typeof envelope.response === "string" && envelope.response.trim()
      ? envelope.response
      : typeof envelope.content === "string"
        ? envelope.content
        : result.stdout

  return {
    args,
    stdout: result.stdout,
    stderr: result.stderr,
    envelope,
    responseText,
    sessionId:
      typeof envelope.session_id === "string"
        ? envelope.session_id
        : typeof envelope.sessionId === "string"
          ? envelope.sessionId
          : sessionId,
    requestedModel: model ?? null,
    resolvedModel: modelToUse,
    fallbackNote,
  }
}

export async function runPlanningTool({ request, model, workspaceContext, context }) {
  const cwd = await workspaceRoot(context)
  const state = await readSessionState(context.sessionID)
  const safeWorkspaceContext = sanitizeWorkspaceContext(workspaceContext, cwd)
  const combinedRequest = [
    String(request || "").trim(),
    safeWorkspaceContext ? `OpenCode workspace context:\n${safeWorkspaceContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  const knowledge = await loadRelevantKnowledge({ prompt: combinedRequest, cwd })
  const plannerPrompt = createPlannerPrompt({
    userPrompt: combinedRequest,
    cwd,
    knowledge,
  })
  const progress = createGeminiProgressReporter({
    context,
    title: "Gemini planning",
    kind: "plan",
    cwd,
    requestPreview: clipInlineText(request, 220),
    requestedModel: model ?? null,
  })
  progress.start()
  let call
  try {
    call = await runGeminiJson({
      prompt: plannerPrompt,
      cwd,
      sessionId: state.geminiSessionId,
      model,
      progress,
    })
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error))
    throw error
  }
  const plan = extractPlan(call.responseText)
  const artifactDir = callDir(context.sessionID, "plan")

  await Promise.all([
    writeText(path.join(artifactDir, "planner-prompt.txt"), plannerPrompt),
    writeText(path.join(artifactDir, "planner-stdout.json"), call.stdout),
    writeText(path.join(artifactDir, "planner-stderr.log"), call.stderr),
    writeJson(path.join(artifactDir, "planner-envelope.json"), call.envelope),
    writeJson(path.join(artifactDir, "plan.json"), plan),
    writeJson(path.join(artifactDir, "request.json"), {
      request,
      workspaceContext: safeWorkspaceContext || null,
      requestedModel: call.requestedModel,
      resolvedModel: call.resolvedModel,
      fallbackNote: call.fallbackNote ?? null,
      cwd,
      createdAt: new Date().toISOString(),
    }),
  ])

  const nextState = {
    ...state,
    geminiSessionId: call.sessionId ?? state.geminiSessionId,
    planCount: Number(state.planCount || 0) + 1,
    lastPlanDir: artifactDir,
    lastGoal: plan.goal,
    lastRequest: request,
    updatedAt: new Date().toISOString(),
  }
  await writeSessionState(context.sessionID, nextState)
  progress.complete({
    geminiSessionId: nextState.geminiSessionId,
    artifactDir,
    goal: plan.goal,
    fallbackNote: call.fallbackNote ?? null,
    summary: clipInlineText(plan.reasoningSummary || plan.workspaceSummary || plan.goal, 220),
    stepCount: plan.executionSteps.length,
  })

  return formatPlanResult({
    plan,
    geminiSessionId: nextState.geminiSessionId,
    artifactDir,
    fallbackNote: call.fallbackNote,
  })
}

export async function runReviewTool({
  request,
  model,
  implementationSummary,
  changedFiles = [],
  testsRun = [],
  openQuestions,
  context,
}) {
  const cwd = await workspaceRoot(context)
  const state = await readSessionState(context.sessionID)
  const reviewPrompt = createReviewPrompt({
    request,
    implementationSummary,
    changedFiles,
    testsRun,
    openQuestions,
    cwd,
  })
  const progress = createGeminiProgressReporter({
    context,
    title: "Gemini review",
    kind: "review",
    cwd,
    requestPreview: clipInlineText(request, 220),
    requestedModel: model ?? null,
  })
  progress.start()
  let call
  try {
    call = await runGeminiJson({
      prompt: reviewPrompt,
      cwd,
      sessionId: state.geminiSessionId,
      model,
      progress,
    })
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error))
    throw error
  }
  const review = extractReview(call.responseText)
  const artifactDir = callDir(context.sessionID, "review")

  await Promise.all([
    writeText(path.join(artifactDir, "review-prompt.txt"), reviewPrompt),
    writeText(path.join(artifactDir, "review-stdout.json"), call.stdout),
    writeText(path.join(artifactDir, "review-stderr.log"), call.stderr),
    writeJson(path.join(artifactDir, "review-envelope.json"), call.envelope),
    writeJson(path.join(artifactDir, "review.json"), review),
    writeJson(path.join(artifactDir, "request.json"), {
      request,
      implementationSummary,
      changedFiles,
      testsRun,
      openQuestions: openQuestions ?? null,
      requestedModel: call.requestedModel,
      resolvedModel: call.resolvedModel,
      fallbackNote: call.fallbackNote ?? null,
      cwd,
      createdAt: new Date().toISOString(),
    }),
  ])

  const nextState = {
    ...state,
    geminiSessionId: call.sessionId ?? state.geminiSessionId,
    reviewCount: Number(state.reviewCount || 0) + 1,
    lastReviewDir: artifactDir,
    lastReviewVerdict: review.verdict,
    updatedAt: new Date().toISOString(),
  }
  await writeSessionState(context.sessionID, nextState)

  await appendKnowledgeRecord({
    runId: `${safeSegment(context.sessionID)}:${createStamp()}`,
    cwd,
    prompt: request,
    goal: request,
    reasoningSummary: review.summary,
    plannerSessionId: nextState.geminiSessionId,
    workerStatus: review.verdict,
    createdAt: new Date().toISOString(),
    artifactDir,
  })

  progress.complete({
    geminiSessionId: nextState.geminiSessionId,
    artifactDir,
    verdict: review.verdict,
    fallbackNote: call.fallbackNote ?? null,
    summary: clipInlineText(review.summary, 220),
    findingCount: review.findings.length,
  })

  return formatReviewResult({
    review,
    geminiSessionId: nextState.geminiSessionId,
    artifactDir,
    fallbackNote: call.fallbackNote,
  })
}

export async function runRawGeminiTool({ argv, model, stdin, reuseSession = true, context }) {
  const cwd = await workspaceRoot(context)
  const state = await readSessionState(context.sessionID)
  const settings = await loadSettings()
  const workspaceArgs = buildWorkspaceScopedGeminiArgs({
    cwd,
    sandboxEnabled: getGeminiSandboxEnabled(settings),
  })
  const args = sanitizeRawGeminiArgs(Array.isArray(argv) ? [...argv] : [])
  const hasModelOverride = args.includes("-m") || args.includes("--model")
  if (model && !hasModelOverride) {
    args.unshift(model)
    args.unshift("-m")
  }
  const shouldResume = reuseSession && state.geminiSessionId && !args.includes("--resume")
  if (shouldResume) {
    args.unshift(state.geminiSessionId)
    args.unshift("--resume")
  }

  const progress = createGeminiProgressReporter({
    context,
    title: "Gemini CLI",
    kind: "raw",
    cwd,
    requestPreview: clipInlineText(args.join(" "), 220),
    requestedModel: model ?? null,
  })
  progress.setResolvedModel(model ?? null)
  progress.start()
  let result
  try {
    result = await runCommand({
      commandSpec: getGeminiCommandSpec(),
      args: [...workspaceArgs, ...args],
      cwd,
      input: stdin,
      timeoutMs: getGeminiTimeoutMs(settings),
      onStdout: (chunk) => progress.onStdout(chunk),
      onStderr: (chunk) => progress.onStderr(chunk),
    })
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error))
    throw error
  }

  if (!result.ok || result.timedOut) {
    progress.fail(formatGeminiFailure({ result, args: [...workspaceArgs, ...args], timeoutMs: getGeminiTimeoutMs(settings) }))
    throw new Error(formatGeminiFailure({ result, args: [...workspaceArgs, ...args], timeoutMs: getGeminiTimeoutMs(settings) }))
  }

  let nextGeminiSessionId = state.geminiSessionId
  try {
    const envelope = extractEnvelope(result.stdout)
    if (typeof envelope.session_id === "string") nextGeminiSessionId = envelope.session_id
    if (typeof envelope.sessionId === "string") nextGeminiSessionId = envelope.sessionId
  } catch {
  }

  const artifactDir = callDir(context.sessionID, "raw")
  await Promise.all([
    writeJson(path.join(artifactDir, "request.json"), {
      argv: [...workspaceArgs, ...args],
      stdin: stdin ?? null,
      cwd,
      createdAt: new Date().toISOString(),
    }),
    writeText(path.join(artifactDir, "stdout.log"), result.stdout),
    writeText(path.join(artifactDir, "stderr.log"), result.stderr),
  ])

  const nextState = {
    ...state,
    geminiSessionId: nextGeminiSessionId,
    rawCount: Number(state.rawCount || 0) + 1,
    lastRawDir: artifactDir,
    updatedAt: new Date().toISOString(),
  }
  await writeSessionState(context.sessionID, nextState)
  progress.complete({
    geminiSessionId: nextState.geminiSessionId,
    artifactDir,
    summary: clipInlineText(result.stdout || result.stderr || "Gemini CLI completed.", 220),
  })

  return formatRawResult({
    argv: [...workspaceArgs, ...args],
    stdout: result.stdout,
    stderr: result.stderr,
    geminiSessionId: nextState.geminiSessionId,
    artifactDir,
  })
}
