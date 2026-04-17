import { createPlannerPrompt, extractPlan } from "./plan.js"
import { createReviewPrompt, extractReview } from "./review.js"
import { parseCommandSpec, runCommand, runInherited } from "./process.js"

const DEFAULT_GEMINI_TIMEOUT_MS = 180000
const GEMINI_SANDBOX_DISABLED = new Set(["0", "false", "no", "off"])

export function getGeminiCommandSpec(env = process.env) {
  return parseCommandSpec({
    env,
    jsonKey: "CUSTCLI_GEMINI_CMD_JSON",
    binKey: "CUSTCLI_GEMINI_BIN",
    fallback: ["gemini"],
  })
}

export function getGeminiTimeoutMs(env = process.env) {
  const raw = env.CUSTCLI_GEMINI_TIMEOUT_MS
  if (raw === undefined || raw === null || raw === "") return DEFAULT_GEMINI_TIMEOUT_MS
  const parsed = Number.parseInt(String(raw), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GEMINI_TIMEOUT_MS
}

export function getGeminiSandboxEnabled(env = process.env) {
  const raw = String(env.CUSTCLI_GEMINI_SANDBOX ?? "").trim().toLowerCase()
  if (!raw) return true
  return !GEMINI_SANDBOX_DISABLED.has(raw)
}

function buildWorkspaceScopedGeminiArgs({ cwd, sandboxEnabled }) {
  const args = ["--include-directories", cwd]
  if (sandboxEnabled) args.push("--sandbox")
  return args
}

function clipText(text, limit = 4000) {
  const value = String(text || "").trim()
  if (!value) return "(empty)"
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n[output truncated]`
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
  const argText = args.join(" ")
  const guidance =
    'Run `gemini` once in a normal terminal to finish sign-in, or configure `GEMINI_API_KEY` / Vertex AI environment variables, then retry.'
  const snippet = clipText(combinedOutput, 1200)

  if (result.timedOut) {
    return [
      `Gemini planner went quiet for ${timeoutMs}ms.`,
      "Likely cause: Gemini is waiting on authentication, another interactive confirmation, backend capacity, or stopped producing output.",
      guidance,
      `Gemini args: ${argText}`,
      `Last output snippet: ${snippet}`,
    ].join("\n")
  }

  if (result.code === 41 || isGeminiAuthIssue(combinedOutput)) {
    return [
      "Gemini CLI needs authentication before custcli can use it in headless mode.",
      guidance,
      `Gemini args: ${argText}`,
      `Last output snippet: ${snippet}`,
    ].join("\n")
  }

  if (isGeminiNonInteractiveApprovalIssue(combinedOutput)) {
    return [
      "Gemini CLI requested manual confirmation that is not available in custcli headless planner mode.",
      "Use `gemini` directly for that interactive action first, then retry from custcli.",
      `Gemini args: ${argText}`,
      `Last output snippet: ${snippet}`,
    ].join("\n")
  }

  return `Gemini planner failed with code ${result.code}: ${result.stderr || result.stdout}`
}

function extractEnvelope(text) {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("Gemini planner returned empty output.")
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new Error("Gemini planner did not return valid JSON envelope.")
  }
}

export async function runGeminiPlanner({
  cwd,
  userPrompt,
  plannerModel,
  plannerSession,
  plannerApprovalMode = "plan",
  commandSpec = getGeminiCommandSpec(),
  knowledge = [],
}) {
  const plannerPrompt = createPlannerPrompt({
    userPrompt,
    cwd,
    knowledge,
  })
  const result = await runGeminiJsonCall({
    cwd,
    prompt: plannerPrompt,
    plannerModel,
    plannerSession,
    plannerApprovalMode,
    commandSpec,
    responseParser: extractPlan,
  })
  return {
    ...result,
    plan: result.parsed,
  }
}

async function runGeminiJsonCall({
  cwd,
  prompt,
  plannerModel,
  plannerSession,
  plannerApprovalMode = "plan",
  commandSpec = getGeminiCommandSpec(),
  responseParser,
}) {
  const timeoutMs = getGeminiTimeoutMs()
  const workspaceArgs = buildWorkspaceScopedGeminiArgs({
    cwd,
    sandboxEnabled: getGeminiSandboxEnabled(),
  })

  const buildArgs = (modelOverride) => {
    const args = ["--approval-mode", plannerApprovalMode, "--output-format", "json", ...workspaceArgs]
    if (modelOverride) args.push("-m", modelOverride)
    if (plannerSession) args.push("--resume", plannerSession)
    args.push("-p", prompt)
    return args
  }

  let args = buildArgs(plannerModel)
  let result = await runCommand({
    commandSpec,
    args,
    cwd,
    timeoutMs,
  })

  let fallbackNote
  if ((!result.ok || result.timedOut) && plannerModel) {
    const combinedOutput = [result.stderr, result.stdout].filter(Boolean).join("\n")
    if (!result.timedOut && (isGeminiModelNotFound(combinedOutput) || isGeminiCapacityIssue(combinedOutput))) {
      args = buildArgs(undefined)
      result = await runCommand({
        commandSpec,
        args,
        cwd,
        timeoutMs,
      })
      fallbackNote = isGeminiModelNotFound(combinedOutput)
        ? `Gemini model override "${plannerModel}" was unavailable, so custcli retried without an explicit model override.`
        : `Gemini model override "${plannerModel}" hit server capacity limits, so custcli retried without an explicit model override.`
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
    commandSpec,
    args,
    prompt,
    envelope,
    parsed: responseParser(responseText),
    plannerSessionId:
      typeof envelope.session_id === "string"
        ? envelope.session_id
        : typeof envelope.sessionId === "string"
          ? envelope.sessionId
          : undefined,
    requestedModel: plannerModel ?? null,
    fallbackNote,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  }
}

export async function runGeminiReviewer({
  cwd,
  request,
  implementationSummary,
  changedFiles = [],
  testsRun = [],
  openQuestions,
  contradictions = [],
  planGoal,
  planSummary,
  plannerModel,
  plannerSession,
  plannerApprovalMode = "plan",
  commandSpec = getGeminiCommandSpec(),
}) {
  const reviewPrompt = createReviewPrompt({
    request,
    implementationSummary,
    changedFiles,
    testsRun,
    openQuestions,
    contradictions,
    planGoal,
    planSummary,
    cwd,
  })

  const result = await runGeminiJsonCall({
    cwd,
    prompt: reviewPrompt,
    plannerModel,
    plannerSession,
    plannerApprovalMode,
    commandSpec,
    responseParser: extractReview,
  })

  return {
    ...result,
    review: result.parsed,
  }
}

export async function runGeminiPassthrough({ args, cwd, commandSpec = getGeminiCommandSpec() }) {
  await runInherited({
    commandSpec,
    args,
    cwd,
  })
}
