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

function uniqueStrings(values) {
  return Array.from(new Set(asArray(values)))
}

function normalizeSeverity(value) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized
  }
  return "medium"
}

function normalizeStep(step, index, globals) {
  const title = String(step?.title ?? step?.name ?? `Step ${index + 1}`)
  const doneWhen = asArray(step?.doneWhen ?? step?.success_criteria)
  const claims = uniqueStrings(step?.claims ?? step?.claim ?? doneWhen ?? [`Complete ${title}`])
  const expectedEvidence = uniqueStrings(step?.expectedEvidence ?? step?.expected_evidence ?? doneWhen)
  const writeScope = uniqueStrings(step?.writeScope ?? step?.write_scope ?? step?.paths ?? step?.files)
  const verificationRules = uniqueStrings(
    step?.verificationRules ?? step?.verification_rules ?? step?.verification_rule ?? doneWhen ?? globals.successCriteria,
  )
  const fallback = uniqueStrings(step?.fallback ?? step?.fallback_steps ?? step?.fallbackSteps ?? globals.replanTriggers)

  return {
    id: String(step?.id ?? `step-${index + 1}`),
    title,
    goal: String(step?.goal ?? title),
    description: String(step?.description ?? step?.details ?? step?.prompt ?? ""),
    opencodePrompt: String(
      step?.opencodePrompt ??
        step?.worker_prompt ??
        step?.prompt ??
        `Execute "${title}" in the current workspace.`,
    ),
    dependsOn: asArray(step?.dependsOn ?? step?.requires),
    doneWhen,
    claims: claims.length > 0 ? claims : [`Complete ${title}`],
    expectedEvidence: expectedEvidence.length > 0 ? expectedEvidence : doneWhen,
    writeScope: writeScope.length > 0 ? writeScope : ["<workspace>"],
    verificationRules: verificationRules.length > 0 ? verificationRules : doneWhen,
    fallback: fallback.length > 0 ? fallback : ["Escalate the contradiction and request a corrected plan."],
  }
}

function ensureUniqueStepIds(steps) {
  const counts = new Map()
  return steps.map((step) => {
    const current = counts.get(step.id) ?? 0
    counts.set(step.id, current + 1)
    if (current === 0) return step
    return {
      ...step,
      id: `${step.id}-${current + 1}`,
    }
  })
}

function sanitizeDependencies(steps) {
  const knownIds = new Set(steps.map((step) => step.id))
  return steps.map((step) => ({
    ...step,
    dependsOn: uniqueStrings(step.dependsOn).filter((item) => item !== step.id && knownIds.has(item)),
  }))
}

function machineCheckPlan(plan) {
  const steps = Array.isArray(plan?.executionSteps) ? plan.executionSteps : []
  const issues = []
  const warnings = []
  const ids = new Set()

  for (const step of steps) {
    if (ids.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}" remained after normalization.`)
    }
    ids.add(step.id)
    if (!step.opencodePrompt.trim()) issues.push(`Step "${step.id}" is missing an execution prompt.`)
    if (step.writeScope.length === 1 && step.writeScope[0] === "<workspace>") {
      warnings.push(`Step "${step.id}" did not provide a narrow write scope.`)
    }
    if (step.expectedEvidence.length === 0) {
      warnings.push(`Step "${step.id}" did not provide explicit expected evidence.`)
    }
    if (step.fallback.length === 0) {
      warnings.push(`Step "${step.id}" did not provide a fallback path.`)
    }
  }

  return {
    readyForExecution: issues.length === 0,
    issues,
    warnings,
    checks: [
      {
        name: "unique_step_ids",
        ok: issues.every((item) => !/Duplicate step id/i.test(item)),
      },
      {
        name: "dependency_graph",
        ok: steps.every((step) => step.dependsOn.every((item) => item !== step.id)),
      },
      {
        name: "claims_present",
        ok: steps.every((step) => step.claims.length > 0),
      },
      {
        name: "expected_evidence_present",
        ok: steps.every((step) => step.expectedEvidence.length > 0),
      },
      {
        name: "verification_rules_present",
        ok: steps.every((step) => step.verificationRules.length > 0),
      },
      {
        name: "fallback_present",
        ok: steps.every((step) => step.fallback.length > 0),
      },
    ],
  }
}

function compactPlan(plan) {
  return {
    goal: clipInlineText(plan?.goal, 220) || "Complete the requested work",
    workspaceSummary: clipInlineText(plan?.workspaceSummary, 320),
    reasoningSummary: clipInlineText(plan?.reasoningSummary, 320),
    decisionLog: asArray(plan?.decisionLog).slice(0, 5).map((item) => clipInlineText(item, 180)),
    findings: asArray(plan?.findings).slice(0, 5).map((item) => clipInlineText(item, 180)),
    assumptions: asArray(plan?.assumptions).slice(0, 5).map((item) => clipInlineText(item, 180)),
    risks: asArray(plan?.risks).slice(0, 5).map((item) => clipInlineText(item, 180)),
    planClaims: uniqueStrings(plan?.planClaims).slice(0, 6).map((item) => clipInlineText(item, 180)),
    executionSteps: (Array.isArray(plan?.executionSteps) ? plan.executionSteps : []).map((step, index) => ({
      id: String(step?.id ?? `step-${index + 1}`),
      title: clipInlineText(step?.title ?? `Step ${index + 1}`, 140),
      goal: clipInlineText(step?.goal ?? step?.title ?? `Step ${index + 1}`, 160),
      description: clipInlineText(step?.description ?? "", 220),
      opencodePrompt: clipInlineText(step?.opencodePrompt ?? "", 320),
      dependsOn: asArray(step?.dependsOn).slice(0, 5).map((item) => clipInlineText(item, 120)),
      doneWhen: asArray(step?.doneWhen).slice(0, 5).map((item) => clipInlineText(item, 140)),
      claims: asArray(step?.claims).slice(0, 5).map((item) => clipInlineText(item, 140)),
      expectedEvidence: asArray(step?.expectedEvidence).slice(0, 5).map((item) => clipInlineText(item, 140)),
      writeScope: asArray(step?.writeScope).slice(0, 5).map((item) => clipInlineText(item, 120)),
      verificationRules: asArray(step?.verificationRules).slice(0, 5).map((item) => clipInlineText(item, 140)),
      fallback: asArray(step?.fallback).slice(0, 5).map((item) => clipInlineText(item, 140)),
    })),
    replanTriggers: asArray(plan?.replanTriggers).slice(0, 5).map((item) => clipInlineText(item, 160)),
    successCriteria: asArray(plan?.successCriteria).slice(0, 5).map((item) => clipInlineText(item, 180)),
    machineCheck: {
      readyForExecution: Boolean(plan?.machineCheck?.readyForExecution),
      issues: asArray(plan?.machineCheck?.issues).slice(0, 5).map((item) => clipInlineText(item, 160)),
      warnings: asArray(plan?.machineCheck?.warnings).slice(0, 5).map((item) => clipInlineText(item, 160)),
      checks: Array.isArray(plan?.machineCheck?.checks)
        ? plan.machineCheck.checks.map((item) => ({
            name: String(item?.name ?? ""),
            ok: Boolean(item?.ok),
          }))
        : [],
    },
  }
}

function normalizePlan(plan, rawResponse) {
  const globals = {
    replanTriggers: asArray(plan?.replan_triggers ?? plan?.replanTriggers),
    successCriteria: asArray(plan?.success_criteria ?? plan?.successCriteria),
  }

  const rawSteps = Array.isArray(plan?.execution_steps ?? plan?.executionSteps)
    ? plan.execution_steps ?? plan.executionSteps
    : []
  let executionSteps = rawSteps.length
    ? rawSteps.map((step, index) => normalizeStep(step, index, globals))
    : [
        normalizeStep(
          {
            id: "step-1",
            title: "Implement requested work",
            goal: "Implement the requested work in the current workspace.",
            description: "Apply the planned implementation in the current workspace.",
            opencodePrompt: "Implement the requested work in the current workspace.",
            doneWhen: ["The requested work is implemented and verified."],
          },
          0,
          globals,
        ),
      ]

  executionSteps = sanitizeDependencies(ensureUniqueStepIds(executionSteps))

  const normalized = {
    goal: String(plan?.goal ?? "Complete the requested work"),
    workspaceSummary: String(plan?.workspace_summary ?? plan?.workspaceSummary ?? ""),
    reasoningSummary: String(plan?.reasoning_summary ?? plan?.reasoningSummary ?? ""),
    decisionLog: asArray(plan?.decision_log ?? plan?.decisionLog),
    findings: asArray(plan?.findings),
    assumptions: asArray(plan?.assumptions),
    risks: asArray(plan?.risks),
    planClaims: uniqueStrings(plan?.plan_claims ?? plan?.planClaims ?? globals.successCriteria),
    executionSteps,
    replanTriggers: globals.replanTriggers,
    successCriteria: globals.successCriteria,
    rawResponse,
  }

  if (!normalized.reasoningSummary) {
    normalized.reasoningSummary = normalized.findings[0] ?? "Planner returned a plan without a separate reasoning summary."
  }
  if (normalized.planClaims.length === 0) {
    normalized.planClaims = uniqueStrings([
      ...normalized.successCriteria,
      ...normalized.executionSteps.flatMap((step) => step.claims),
    ])
  }

  normalized.machineCheck = machineCheckPlan(normalized)
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
      plan_claims: ["Requested work is implemented and verified."],
      execution_steps: [
        {
          id: "step-1",
          title: "Implement based on planner notes",
          goal: "Implement the requested work based on the planner notes.",
          description: responseText.trim(),
          opencodePrompt: responseText.trim() || "Implement the requested work in the current workspace.",
          doneWhen: ["Requested work is implemented and verified."],
          claims: ["Requested work is implemented and verified."],
          expectedEvidence: ["Worker output confirms the requested change."],
          writeScope: ["<workspace>"],
          verificationRules: ["Validate the requested work before concluding."],
          fallback: ["Review the raw planner artifact before concluding."],
        },
      ],
      replan_triggers: ["Worker reports ambiguity or plan mismatch."],
      success_criteria: ["Requested work is implemented and verified."],
    },
    responseText,
  )
}

function normalizeFinding(item, index) {
  if (typeof item === "string") {
    return {
      id: `finding-${index + 1}`,
      severity: "medium",
      summary: item.trim(),
      details: item.trim(),
      contradictionTarget: null,
      evidence: "",
      replanScope: [],
      verificationTarget: null,
    }
  }

  return {
    id: String(item?.id ?? `finding-${index + 1}`),
    severity: normalizeSeverity(item?.severity),
    summary: String(item?.summary ?? item?.title ?? item?.claim ?? `Finding ${index + 1}`),
    details: String(item?.details ?? item?.summary ?? item?.title ?? ""),
    contradictionTarget: item?.contradictionTarget ? String(item.contradictionTarget) : null,
    evidence: String(item?.evidence ?? ""),
    replanScope: asArray(item?.replanScope),
    verificationTarget: item?.verificationTarget ? String(item.verificationTarget) : null,
  }
}

function compactReview(review) {
  return {
    verdict: String(review?.verdict ?? "needs_followup"),
    summary: clipInlineText(review?.summary, 320),
    findings: asArray(review?.findings).slice(0, 5).map((item) => clipInlineText(item, 180)),
    findingDetails: (Array.isArray(review?.findingDetails) ? review.findingDetails : []).slice(0, 5).map((item) => ({
      id: String(item?.id ?? ""),
      severity: normalizeSeverity(item?.severity),
      summary: clipInlineText(item?.summary, 180),
      contradictionTarget: item?.contradictionTarget ?? null,
      verificationTarget: item?.verificationTarget ?? null,
      replanScope: asArray(item?.replanScope).slice(0, 5).map((entry) => clipInlineText(entry, 120)),
    })),
    risks: asArray(review?.risks).slice(0, 5).map((item) => clipInlineText(item, 180)),
    followUpSteps: asArray(review?.followUpSteps).slice(0, 5).map((item) => clipInlineText(item, 180)),
    tests: asArray(review?.tests).slice(0, 5).map((item) => clipInlineText(item, 160)),
  }
}

function normalizeReview(review, rawResponse) {
  const findingDetails = Array.isArray(review?.findings)
    ? review.findings.map((item, index) => normalizeFinding(item, index))
    : []

  const normalized = {
    verdict: String(review?.verdict ?? "needs_followup"),
    summary: String(review?.summary ?? review?.reasoning_summary ?? ""),
    findings: findingDetails.map((item) => item.summary),
    findingDetails,
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
    "Return strict JSON only. Do not wrap the JSON in markdown fences.",
    "Every execution step must be machine-checkable and scoped for later contradiction handling.",
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
    '  "plan_claims": ["string"],',
    '  "execution_steps": [',
    "    {",
    '      "id": "string",',
    '      "title": "string",',
    '      "goal": "string",',
    '      "description": "string",',
    '      "opencodePrompt": "string",',
    '      "dependsOn": ["string"],',
    '      "doneWhen": ["string"],',
    '      "claims": ["string"],',
    '      "expectedEvidence": ["string"],',
    '      "writeScope": ["string"],',
    '      "verificationRules": ["string"],',
    '      "fallback": ["string"]',
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

function createReviewPrompt({ request, compactPlan, compactEvidence, testsRun, openQuestions, contradictions = [], routing, cwd }) {
  const tests = testsRun.length ? testsRun.map((item) => `- ${item}`) : ["- None provided"]

  return [
    "You are reviewing work performed by OpenCode in a paired coding workflow.",
    "Assess correctness, regression risk, plan fidelity, and missing validation using the structured plan and evidence graph below.",
    "Return strict JSON only. Do not wrap the JSON in markdown fences.",
    "",
    "Your JSON schema:",
    "{",
    '  "verdict": "approved | changes_requested | needs_followup",',
    '  "summary": "string",',
    '  "findings": [',
    "    {",
    '      "id": "string",',
    '      "severity": "critical | high | medium | low",',
    '      "summary": "string",',
    '      "details": "string",',
    '      "contradictionTarget": "string | null",',
    '      "evidence": "string",',
    '      "replanScope": ["string"],',
    '      "verificationTarget": "string | null"',
    "    }",
    "  ],",
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
    "Compact plan artifact:",
    JSON.stringify(compactPlan ?? {}, null, 2),
    "",
    "Compact execution evidence:",
    JSON.stringify(compactEvidence ?? {}, null, 2),
    "",
    "Concrete contradictions from prior passes:",
    JSON.stringify(Array.isArray(contradictions) ? contradictions : [], null, 2),
    "",
    "Routing context:",
    JSON.stringify(routing ?? {}, null, 2),
    "",
    "Tests already run:",
    ...tests,
    "",
    "Open questions:",
    openQuestions?.trim() || "None provided",
  ].join("\n")
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

function countSignals(items, threshold = 0) {
  const total = Array.isArray(items) ? items.length : 0
  return total > threshold ? 1 : 0
}

function normalizeChangedFiles(files) {
  return uniqueStrings(files).sort()
}

function pathMatchesScope(filePath, scope) {
  const normalizedScope = String(scope ?? "").trim().replace(/\\/g, "/").toLowerCase()
  if (!normalizedScope || normalizedScope === "<workspace>") return true

  const normalizedFile = String(filePath ?? "").trim().replace(/\\/g, "/").toLowerCase()
  return (
    normalizedFile === normalizedScope ||
    normalizedFile.endsWith(`/${normalizedScope}`) ||
    normalizedFile.includes(normalizedScope)
  )
}

function pickMatchedItems(items, text, threshold = 2) {
  const haystack = String(text ?? "")
  return uniqueStrings(items).filter((item) => overlapScore(item, haystack) >= threshold)
}

function deriveVerificationStatus({ failures, writeScopeMatches, claimMatches, expectedMatches, verificationMatches }) {
  if (failures.length > 0) return "blocked"
  const evidenceCount = writeScopeMatches.length + claimMatches.length + expectedMatches.length + verificationMatches.length
  if (evidenceCount === 0) return "missing"
  if (writeScopeMatches.length > 0 && (claimMatches.length > 0 || expectedMatches.length > 0 || verificationMatches.length > 0)) {
    return "verified"
  }
  return "partial"
}

function createLiveEvidenceGraph({
  plan,
  implementationSummary,
  changedFiles,
  testsRun,
  openQuestions,
  passNumber,
  request,
  geminiSessionId,
}) {
  const normalizedChangedFiles = normalizeChangedFiles(changedFiles)
  const summaryText = [implementationSummary, ...testsRun, openQuestions].filter(Boolean).join("\n")
  const observedFailures = /fail|error|regress|blocked|missing/i.test(summaryText)
    ? [clipInlineText(summaryText, 220)]
    : []
  const stepEvidence = (Array.isArray(plan?.executionSteps) ? plan.executionSteps : []).map((step) => {
    const writeScopeMatches = normalizedChangedFiles.filter((filePath) => step.writeScope.some((scope) => pathMatchesScope(filePath, scope)))
    const claimMatches = pickMatchedItems(step.claims, summaryText, 2)
    const expectedMatches = pickMatchedItems(step.expectedEvidence, summaryText, 2)
    const verificationMatches = pickMatchedItems(step.verificationRules, summaryText, 2)
    const verificationStatus = deriveVerificationStatus({
      failures: observedFailures,
      writeScopeMatches,
      claimMatches,
      expectedMatches,
      verificationMatches,
    })

    return {
      stepId: step.id,
      title: step.title,
      goal: step.goal,
      claims: step.claims,
      expectedEvidence: step.expectedEvidence,
      writeScope: step.writeScope,
      verificationRules: step.verificationRules,
      fallback: step.fallback,
      writeScopeMatches,
      observedEvidence: uniqueStrings([
        ...writeScopeMatches.map((item) => `changed:${item}`),
        ...claimMatches.map((item) => `claim:${clipInlineText(item, 120)}`),
        ...expectedMatches.map((item) => `expected:${clipInlineText(item, 120)}`),
        ...verificationMatches.map((item) => `verify:${clipInlineText(item, 120)}`),
        ...testsRun.map((item) => `test:${clipInlineText(item, 120)}`),
      ]),
      missingEvidence: step.expectedEvidence.filter((item) => !expectedMatches.includes(item)),
      verificationStatus,
    }
  })

  const verifiedStepCount = stepEvidence.filter((item) => item.verificationStatus === "verified").length
  const partialStepCount = stepEvidence.filter((item) => item.verificationStatus === "partial").length
  const missingStepCount = stepEvidence.filter((item) => item.verificationStatus === "missing").length
  const blockedStepCount = stepEvidence.filter((item) => item.verificationStatus === "blocked").length

  return {
    schemaVersion: 1,
    request: String(request ?? "").trim(),
    passNumber,
    plannerSessionId: geminiSessionId ?? null,
    goal: String(plan?.goal ?? "Complete the requested work"),
    commandResult: {
      status: observedFailures.length ? "needs_followup" : "completed",
      code: null,
      ok: observedFailures.length === 0,
    },
    changedFiles: normalizedChangedFiles,
    observedFailures,
    testsRun: asArray(testsRun),
    finalText: String(implementationSummary ?? "").trim(),
    stepEvidence,
    verifiedStepCount,
    partialStepCount,
    missingStepCount,
    blockedStepCount,
    summary: clipInlineText(
      [
        `Review evidence pass ${passNumber}`,
        `Changed files: ${normalizedChangedFiles.length}`,
        `Verified steps: ${verifiedStepCount}/${stepEvidence.length}`,
        observedFailures.length ? `Observed failures: ${observedFailures.length}` : "Observed failures: 0",
      ].join(" | "),
      220,
    ),
  }
}

function compactEvidenceGraph(graph) {
  return {
    schemaVersion: graph?.schemaVersion ?? 1,
    passNumber: graph?.passNumber ?? 1,
    goal: clipInlineText(graph?.goal, 180),
    commandResult: {
      status: String(graph?.commandResult?.status ?? "unknown"),
      code: graph?.commandResult?.code ?? null,
      ok: Boolean(graph?.commandResult?.ok),
    },
    changedFiles: normalizeChangedFiles(graph?.changedFiles).slice(0, 12),
    observedFailures: uniqueStrings(graph?.observedFailures).slice(0, 8).map((item) => clipInlineText(item, 160)),
    testsRun: asArray(graph?.testsRun).slice(0, 8).map((item) => clipInlineText(item, 140)),
    finalText: clipInlineText(graph?.finalText, 320),
    verifiedStepCount: Number(graph?.verifiedStepCount ?? 0),
    partialStepCount: Number(graph?.partialStepCount ?? 0),
    missingStepCount: Number(graph?.missingStepCount ?? 0),
    blockedStepCount: Number(graph?.blockedStepCount ?? 0),
    summary: clipInlineText(graph?.summary, 220),
    stepEvidence: (Array.isArray(graph?.stepEvidence) ? graph.stepEvidence : []).map((item) => ({
      stepId: String(item?.stepId ?? ""),
      title: clipInlineText(item?.title, 120),
      verificationStatus: String(item?.verificationStatus ?? "missing"),
      writeScopeMatches: normalizeChangedFiles(item?.writeScopeMatches).slice(0, 6),
      observedEvidence: uniqueStrings(item?.observedEvidence).slice(0, 6).map((entry) => clipInlineText(entry, 140)),
      missingEvidence: uniqueStrings(item?.missingEvidence).slice(0, 4).map((entry) => clipInlineText(entry, 140)),
    })),
  }
}

function findFallbackTarget(evidenceGraph) {
  const stepEvidence = Array.isArray(evidenceGraph?.stepEvidence) ? evidenceGraph.stepEvidence : []
  return (
    stepEvidence.find((item) => item.verificationStatus === "blocked") ??
    stepEvidence.find((item) => item.verificationStatus === "missing") ??
    stepEvidence.find((item) => item.verificationStatus === "partial") ??
    stepEvidence[0] ??
    null
  )
}

function buildContradictions({ review, evidenceGraph, passNumber }) {
  const stepIndex = new Map(
    (Array.isArray(evidenceGraph?.stepEvidence) ? evidenceGraph.stepEvidence : []).map((item) => [item.stepId, item]),
  )

  const fallbackTarget = findFallbackTarget(evidenceGraph)
  const contradictions = []
  const findings = Array.isArray(review?.findingDetails) && review.findingDetails.length > 0
    ? review.findingDetails
    : asArray(review?.findings).map((item, index) => normalizeFinding(item, index))

  for (const [index, finding] of findings.entries()) {
    const target =
      (finding?.contradictionTarget && stepIndex.get(String(finding.contradictionTarget))) ??
      fallbackTarget

    contradictions.push({
      id: `pass-${passNumber}-finding-${index + 1}`,
      severity: normalizeSeverity(finding?.severity),
      claim: String(finding?.summary ?? finding?.details ?? `Finding ${index + 1}`).trim(),
      evidence: String(
        finding?.evidence ??
          target?.observedEvidence?.join("; ") ??
          evidenceGraph?.summary ??
          review?.summary ??
          "",
      ).trim(),
      source: "review:finding",
      resolutionStatus: "open",
      contradictionTarget: target?.stepId ?? null,
      verificationTarget: String(
        finding?.verificationTarget ??
          target?.verificationRules?.[0] ??
          target?.expectedEvidence?.[0] ??
          "",
      ).trim() || null,
      replanScope: uniqueStrings(finding?.replanScope ?? [target?.stepId, ...(target?.writeScope ?? [])]),
      passNumber,
    })
  }

  for (const [index, risk] of asArray(review?.risks).entries()) {
    const target = fallbackTarget
    contradictions.push({
      id: `pass-${passNumber}-risk-${index + 1}`,
      severity: "medium",
      claim: risk,
      evidence: String(target?.observedEvidence?.join("; ") ?? evidenceGraph?.summary ?? review?.summary ?? "").trim(),
      source: "review:risk",
      resolutionStatus: "open",
      contradictionTarget: target?.stepId ?? null,
      verificationTarget: String(target?.verificationRules?.[0] ?? target?.expectedEvidence?.[0] ?? "").trim() || null,
      replanScope: uniqueStrings([target?.stepId, ...(target?.writeScope ?? [])]),
      passNumber,
    })
  }

  return contradictions
}

function compactContradictions(contradictions) {
  return (Array.isArray(contradictions) ? contradictions : []).map((item) => ({
    id: String(item?.id ?? ""),
    severity: normalizeSeverity(item?.severity),
    claim: clipInlineText(item?.claim, 160),
    evidence: clipInlineText(item?.evidence, 180),
    source: String(item?.source ?? "unknown"),
    resolutionStatus: String(item?.resolutionStatus ?? "open"),
    contradictionTarget: item?.contradictionTarget ?? null,
    verificationTarget: item?.verificationTarget ?? null,
    replanScope: uniqueStrings(item?.replanScope).slice(0, 6),
  }))
}

function normalizeContradictionInput(contradictions) {
  return asArray(contradictions).map((item, index) => ({
    id: `input-${index + 1}`,
    severity: "medium",
    claim: item,
    evidence: "",
    source: "tool-input",
    resolutionStatus: "open",
    contradictionTarget: null,
    verificationTarget: null,
    replanScope: [],
  }))
}

function normalizeCompactPlanInput(value) {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return {
        summary: value,
      }
    }
  }
  return value
}

function computeRoutingDecision({ userPrompt, plan, reviewHistory = [], contradictions = [], plannerModel }) {
  const promptLength = String(userPrompt ?? "").trim().length
  const stepCount = Array.isArray(plan?.executionSteps) ? plan.executionSteps.length : 0
  const planRiskCount = asArray(plan?.risks).length
  const assumptionCount = asArray(plan?.assumptions).length
  const contradictionCount = Array.isArray(contradictions) ? contradictions.length : 0
  const changesRequestedCount = (Array.isArray(reviewHistory) ? reviewHistory : []).filter(
    (item) => item?.verdict === "changes_requested" || item?.verdict === "needs_followup",
  ).length

  const complexityScore =
    countSignals(stepCount >= 3 ? [1] : []) +
    countSignals(planRiskCount >= 2 ? [1] : []) +
    countSignals(assumptionCount >= 3 ? [1] : []) +
    countSignals(promptLength >= 400 ? [1] : []) +
    countSignals(contradictionCount >= 1 ? [1] : []) +
    countSignals(changesRequestedCount >= 1 ? [1] : [])

  const reasoningIntensity = complexityScore >= 5 ? "high" : complexityScore >= 3 ? "medium" : "baseline"
  const reviewIntensity =
    contradictionCount > 0 || changesRequestedCount > 0 || planRiskCount >= 2
      ? "high"
      : reasoningIntensity === "high"
        ? "medium"
        : "baseline"

  return {
    schemaVersion: 1,
    complexityScore,
    promptLength,
    reasoning: {
      provider: "gemini",
      plannerModel: plannerModel ?? "auto",
      intensity: reasoningIntensity,
      reviewIntensity,
      loopBudget: contradictionCount > 0 || complexityScore >= 4 ? 2 : 1,
    },
    execution: {
      strategy: complexityScore >= 4 ? "guided" : "direct",
      preferCompactArtifacts: true,
      preferScopedCorrections: true,
    },
    memory: {
      hotFirst: true,
      warmOnDemand: true,
      coldOnExplicitRead: true,
      learnedOnlyAfterPromotion: true,
    },
    branchSearch: {
      enabled: complexityScore >= 6 || contradictionCount >= 2,
      maxBranches: complexityScore >= 7 ? 2 : 1,
    },
    summary: clipInlineText(
      `Routing selected ${reasoningIntensity} planning, ${reviewIntensity} review, and a ${complexityScore >= 4 ? "guided" : "direct"} execution strategy.`,
      220,
    ),
  }
}

function createCandidate({ type, title, content, evidence, gates }) {
  const decision =
    gates.validated && gates.repeated && gates.usefulAcrossSessions && gates.improvesEvals ? "promote" : "hold"

  return {
    id: `${type}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "candidate"}`,
    type,
    title,
    content,
    evidence: uniqueStrings(evidence).slice(0, 8),
    gates,
    decision,
  }
}

function compilePromotions({ history, prompt, plan, review, evidenceGraph, contradictions, routing }) {
  const historyMatches = (Array.isArray(history) ? history : []).filter(
    (item) => overlapScore(prompt, [item.prompt, item.goal, item.reasoningSummary].filter(Boolean).join(" ")) >= 3,
  )
  const successfulMatches = historyMatches.filter((item) => item.workerStatus === "approved" || item.workerStatus === "completed")
  const candidates = []
  const validated = review?.verdict === "approved"
  const contradictionCount = Array.isArray(contradictions) ? contradictions.length : 0
  const recurring = successfulMatches.length >= 1

  const verificationTemplate = uniqueStrings([
    ...asArray(plan?.successCriteria),
    ...asArray(review?.tests),
    ...(Array.isArray(evidenceGraph?.stepEvidence)
      ? evidenceGraph.stepEvidence.flatMap((item) => item.verificationRules ?? [])
      : []),
  ])

  if (verificationTemplate.length > 0) {
    candidates.push(
      createCandidate({
        type: "verification_template",
        title: "Validated review gate",
        content: verificationTemplate.join(" | "),
        evidence: [review?.summary, evidenceGraph?.summary],
        gates: {
          validated,
          repeated: recurring,
          usefulAcrossSessions: verificationTemplate.length >= 2,
          improvesEvals: recurring && contradictionCount === 0,
        },
      }),
    )
  }

  if (validated || contradictionCount > 0) {
    candidates.push(
      createCandidate({
        type: "routing_rule",
        title: "Escalate review on contradiction pressure",
        content:
          contradictionCount > 0
            ? "When contradictions are open, raise review intensity and use scoped correction passes before concluding."
            : "Keep review intensity proportional to plan risk and contradiction pressure.",
        evidence: [routing?.summary, review?.summary],
        gates: {
          validated,
          repeated: recurring || contradictionCount > 0,
          usefulAcrossSessions: true,
          improvesEvals: validated && (recurring || contradictionCount === 0),
        },
      }),
    )
  }

  const reusableScopes = uniqueStrings(
    (Array.isArray(evidenceGraph?.stepEvidence) ? evidenceGraph.stepEvidence : []).flatMap((item) => item.writeScope ?? []),
  ).filter((item) => item !== "<workspace>")

  if (validated && reusableScopes.length > 0) {
    candidates.push(
      createCandidate({
        type: "policy",
        title: "Prefer scoped verification",
        content: `Prefer verifying changed scopes first: ${reusableScopes.join(", ")}`,
        evidence: [evidenceGraph?.summary, ...reusableScopes],
        gates: {
          validated,
          repeated: recurring,
          usefulAcrossSessions: reusableScopes.length >= 1,
          improvesEvals: recurring && contradictionCount === 0,
        },
      }),
    )
  }

  return {
    historySummary: {
      comparedRuns: Array.isArray(history) ? history.length : 0,
      similarRuns: historyMatches.length,
      successfulSimilarRuns: successfulMatches.length,
    },
    candidates,
    promoted: candidates.filter((item) => item.decision === "promote"),
  }
}

function buildMemoryTiers({
  plan,
  planCompact,
  review,
  reviewCompact,
  evidenceGraph,
  evidenceCompact,
  contradictions,
  promotions,
  knowledge,
  routing,
  artifacts,
}) {
  return {
    hot: {
      plan: planCompact,
      review: reviewCompact ?? null,
      evidence: evidenceCompact ?? null,
      contradictions: Array.isArray(contradictions) ? contradictions.slice(0, 8) : [],
      routing,
    },
    warm: {
      relevantKnowledge: (Array.isArray(knowledge) ? knowledge : []).slice(0, 5).map((item) => ({
        goal: clipInlineText(item.goal, 160),
        reasoningSummary: clipInlineText(item.reasoningSummary, 180),
        workerStatus: item.workerStatus,
        artifactDir: item.artifactDir,
      })),
      promotionCandidates: Array.isArray(promotions?.candidates) ? promotions.candidates : [],
      currentSignals: {
        planGoal: clipInlineText(plan?.goal, 160),
        reviewVerdict: review?.verdict ?? null,
      },
    },
    cold: {
      accessMode: "read_on_demand",
      artifacts,
      summary: clipInlineText(evidenceGraph?.summary ?? review?.summary ?? plan?.reasoningSummary, 220),
    },
    learned: {
      promoted: Array.isArray(promotions?.promoted) ? promotions.promoted : [],
      policyCount: (Array.isArray(promotions?.promoted) ? promotions.promoted : []).filter((item) => item.type === "policy").length,
      routingRuleCount: (Array.isArray(promotions?.promoted) ? promotions.promoted : []).filter((item) => item.type === "routing_rule").length,
      verificationTemplateCount: (Array.isArray(promotions?.promoted) ? promotions.promoted : []).filter((item) => item.type === "verification_template").length,
    },
  }
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

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    return JSON.parse(raw)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

async function loadWorkspaceKnowledgeHistory(cwd, limit = 40) {
  const filePath = path.join(artifactRoot, "knowledge", "executions.jsonl")
  const records = await readJsonl(filePath)
  return records.filter((item) => item.cwd === cwd).slice(-limit)
}

function buildColdArtifactIndex() {
  return {
    raw: [
      "planner-prompt.txt",
      "planner-stdout.json",
      "planner-stderr.log",
      "planner-envelope.json",
      "review-prompt.txt",
      "review-stdout.json",
      "review-stderr.log",
      "review-envelope.json",
      "request.json",
      "stdout.log",
      "stderr.log",
    ],
    structured: [
      "plan.json",
      "plan-compact.json",
      "plan-validation.json",
      "review.json",
      "review-compact.json",
      "evidence-graph.json",
      "evidence-compact.json",
      "contradictions.json",
      "contradictions-compact.json",
      "routing.json",
      "promotions.json",
      "memory-hot.json",
      "memory-warm.json",
      "memory-cold.json",
      "memory-learned.json",
    ],
  }
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

function formatPlanResult({ plan, planCompact, routing, geminiSessionId, artifactDir, fallbackNote }) {
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
    `Plan validation: ${plan.machineCheck?.readyForExecution ? "ready" : "needs attention"}`,
    `Routing: ${routing?.summary ?? "not recorded"}`,
    "Key findings:",
    ...(plan.findings.length ? plan.findings.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Key risks:",
    ...(plan.risks.length ? plan.risks.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Next steps:",
    steps || "1. Implement requested work",
    "If more detail is needed, inspect plan-compact.json first, then plan.json and plan-validation.json.",
    "Use this as internal guidance. Do not quote it wholesale to the user.",
  ].join("\n")
}

function formatReviewResult({ review, reviewCompact, evidenceCompact, contradictions, promotions, routing, geminiSessionId, artifactDir, fallbackNote }) {
  return [
    `Verdict: ${review.verdict}`,
    `Review summary: ${clipInlineText(review.summary, 220)}`,
    `Gemini session: ${geminiSessionId ?? "not returned"}`,
    `Review artifacts: ${artifactDir}`,
    ...(fallbackNote ? [`Model note: ${fallbackNote}`] : []),
    `Evidence: ${evidenceCompact?.summary ?? "not recorded"}`,
    `Contradictions: ${Array.isArray(contradictions) ? contradictions.length : 0}`,
    `Promotions: ${Array.isArray(promotions?.promoted) ? promotions.promoted.length : 0}`,
    `Routing: ${routing?.summary ?? "not recorded"}`,
    "Key findings:",
    ...(review.findings.length ? review.findings.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Key risks:",
    ...(review.risks.length ? review.risks.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`) : ["- None recorded"]),
    "Follow-up:",
    ...(reviewCompact?.followUpSteps?.length
      ? reviewCompact.followUpSteps.slice(0, 3).map((item) => `- ${clipInlineText(item, 180)}`)
      : ["- None recorded"]),
    "If more detail is needed, inspect review-compact.json, evidence-compact.json, and contradictions-compact.json first.",
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

export async function runPlanningTool({
  request,
  model,
  workspaceContext,
  contradictions = [],
  previousPlanSummary,
  previousReviewSummary,
  routingContext,
  context,
}) {
  const cwd = await workspaceRoot(context)
  const state = await readSessionState(context.sessionID)
  const safeWorkspaceContext = sanitizeWorkspaceContext(workspaceContext, cwd)
  const compactContradictionInput = compactContradictions(normalizeContradictionInput(contradictions))
  const combinedRequest = [
    String(request || "").trim(),
    safeWorkspaceContext ? `OpenCode workspace context:\n${safeWorkspaceContext}` : "",
    previousPlanSummary ? `Previous compact plan summary:\n${previousPlanSummary}` : "",
    previousReviewSummary ? `Previous compact review summary:\n${previousReviewSummary}` : "",
    compactContradictionInput.length ? `Concrete contradictions:\n${JSON.stringify(compactContradictionInput, null, 2)}` : "",
    routingContext ? `Routing context:\n${routingContext}` : "",
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
  const planCompact = compactPlan(plan)
  const routing = computeRoutingDecision({
    userPrompt: combinedRequest,
    plan: planCompact,
    reviewHistory: previousReviewSummary ? [{ verdict: "changes_requested" }] : [],
    contradictions: compactContradictionInput,
    plannerModel: call.resolvedModel ?? model,
  })
  const artifactDir = callDir(context.sessionID, "plan")

  await Promise.all([
    writeText(path.join(artifactDir, "planner-prompt.txt"), plannerPrompt),
    writeText(path.join(artifactDir, "planner-stdout.json"), call.stdout),
    writeText(path.join(artifactDir, "planner-stderr.log"), call.stderr),
    writeJson(path.join(artifactDir, "planner-envelope.json"), call.envelope),
    writeJson(path.join(artifactDir, "plan.json"), plan),
    writeJson(path.join(artifactDir, "plan-compact.json"), planCompact),
    writeJson(path.join(artifactDir, "plan-validation.json"), plan.machineCheck),
    writeJson(path.join(artifactDir, "routing.json"), routing),
    writeJson(path.join(artifactDir, "request.json"), {
      request,
      workspaceContext: safeWorkspaceContext || null,
      contradictions: compactContradictionInput,
      previousPlanSummary: previousPlanSummary ?? null,
      previousReviewSummary: previousReviewSummary ?? null,
      routingContext: routingContext ?? null,
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
    lastRoutingDir: artifactDir,
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
    routing: routing.summary,
  })

  return formatPlanResult({
    plan,
    planCompact,
    routing,
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
  compactPlan,
  contradictions = [],
  routingContext,
  context,
}) {
  const cwd = await workspaceRoot(context)
  const state = await readSessionState(context.sessionID)
  const explicitCompactPlan = normalizeCompactPlanInput(compactPlan)
  const priorPlan = state.lastPlanDir ? await readJsonIfExists(path.join(state.lastPlanDir, "plan.json")) : null
  const priorPlanCompact = explicitCompactPlan ?? (state.lastPlanDir ? await readJsonIfExists(path.join(state.lastPlanDir, "plan-compact.json")) : null)
  const priorReviewCompact = state.lastReviewDir
    ? (await readJsonIfExists(path.join(state.lastReviewDir, "review-compact.json")))
    : null
  const priorContradictions =
    contradictions.length > 0
      ? compactContradictions(normalizeContradictionInput(contradictions))
      : compactContradictions(
          (state.lastReviewDir ? await readJsonIfExists(path.join(state.lastReviewDir, "contradictions.json")) : null) ?? [],
        )
  const routing =
    (typeof routingContext === "string" && routingContext.trim()
      ? {
          summary: routingContext,
          source: "tool-arg",
        }
      : null) ??
    (state.lastPlanDir ? await readJsonIfExists(path.join(state.lastPlanDir, "routing.json")) : null) ??
    computeRoutingDecision({
      userPrompt: request,
      plan: priorPlanCompact ?? priorPlan ?? { executionSteps: [], risks: [], assumptions: [] },
      reviewHistory: priorReviewCompact ? [priorReviewCompact] : [],
      contradictions: priorContradictions,
      plannerModel: model,
    })
  const evidenceGraph = createLiveEvidenceGraph({
    plan: priorPlan ?? priorPlanCompact ?? { goal: request, executionSteps: [] },
    implementationSummary,
    changedFiles,
    testsRun,
    openQuestions,
    passNumber: Number(state.reviewCount || 0) + 1,
    request,
    geminiSessionId: state.geminiSessionId,
  })
  const evidenceCompact = compactEvidenceGraph(evidenceGraph)
  const reviewPrompt = createReviewPrompt({
    request,
    compactPlan: priorPlanCompact ?? priorPlan ?? null,
    compactEvidence: evidenceCompact,
    testsRun,
    openQuestions,
    contradictions: priorContradictions,
    routing,
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
  const reviewCompact = compactReview(review)
  const nextContradictions = buildContradictions({
    review,
    evidenceGraph,
    passNumber: Number(state.reviewCount || 0) + 1,
  })
  const compactNextContradictions = compactContradictions(nextContradictions)
  const history = await loadWorkspaceKnowledgeHistory(cwd)
  const promotions = compilePromotions({
    history,
    prompt: request,
    plan: priorPlan ?? priorPlanCompact ?? { goal: request, successCriteria: [] },
    review,
    evidenceGraph,
    contradictions: nextContradictions,
    routing,
  })
  const memoryTiers = buildMemoryTiers({
    plan: priorPlan ?? priorPlanCompact ?? { goal: request, reasoningSummary: implementationSummary },
    planCompact: priorPlanCompact ?? priorPlan ?? null,
    review,
    reviewCompact,
    evidenceGraph,
    evidenceCompact,
    contradictions: compactNextContradictions,
    promotions,
    knowledge: await loadRelevantKnowledge({ prompt: request, cwd }),
    routing,
    artifacts: buildColdArtifactIndex(),
  })
  const artifactDir = callDir(context.sessionID, "review")

  await Promise.all([
    writeText(path.join(artifactDir, "review-prompt.txt"), reviewPrompt),
    writeText(path.join(artifactDir, "review-stdout.json"), call.stdout),
    writeText(path.join(artifactDir, "review-stderr.log"), call.stderr),
    writeJson(path.join(artifactDir, "review-envelope.json"), call.envelope),
    writeJson(path.join(artifactDir, "review.json"), review),
    writeJson(path.join(artifactDir, "review-compact.json"), reviewCompact),
    writeJson(path.join(artifactDir, "evidence-graph.json"), evidenceGraph),
    writeJson(path.join(artifactDir, "evidence-compact.json"), evidenceCompact),
    writeJson(path.join(artifactDir, "contradictions.json"), nextContradictions),
    writeJson(path.join(artifactDir, "contradictions-compact.json"), compactNextContradictions),
    writeJson(path.join(artifactDir, "routing.json"), routing),
    writeJson(path.join(artifactDir, "promotions.json"), promotions),
    writeJson(path.join(artifactDir, "memory-hot.json"), memoryTiers.hot),
    writeJson(path.join(artifactDir, "memory-warm.json"), memoryTiers.warm),
    writeJson(path.join(artifactDir, "memory-cold.json"), memoryTiers.cold),
    writeJson(path.join(artifactDir, "memory-learned.json"), memoryTiers.learned),
    writeJson(path.join(artifactDir, "request.json"), {
      request,
      implementationSummary,
      changedFiles,
      testsRun,
      openQuestions: openQuestions ?? null,
      compactPlan: priorPlanCompact ?? null,
      contradictions: priorContradictions,
      routing,
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
    lastRoutingDir: artifactDir,
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
    contradictionCount: nextContradictions.length,
    promotedCount: promotions.promoted.length,
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
    contradictionCount: nextContradictions.length,
    promotedCount: promotions.promoted.length,
  })

  return formatReviewResult({
    review,
    reviewCompact,
    evidenceCompact,
    contradictions: compactNextContradictions,
    promotions,
    routing,
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
