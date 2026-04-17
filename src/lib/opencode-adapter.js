import { parseCommandSpec, runCommand, runInherited } from "./process.js"

export function getOpencodeCommandSpec(env = process.env) {
  return parseCommandSpec({
    env,
    jsonKey: "CUSTCLI_OPENCODE_CMD_JSON",
    binKey: "CUSTCLI_OPENCODE_BIN",
    fallback: ["opencode"],
  })
}

export function createWorkerPrompt({ userPrompt, plan, plannerSessionId }) {
  const steps = plan.executionSteps
    .map((step, index) => {
      const dependsOn = step.dependsOn.length ? `Depends on: ${step.dependsOn.join(", ")}` : "Depends on: none"
      const doneWhen = step.doneWhen.length ? `Done when: ${step.doneWhen.join("; ")}` : "Done when: step intent is satisfied"
      return [
        `${index + 1}. ${step.title}`,
        step.description || "No extra description provided.",
        dependsOn,
        doneWhen,
        `Worker directive: ${step.opencodePrompt}`,
      ].join("\n")
    })
    .join("\n\n")

  return [
    "You are the execution engine.",
    "Follow the planner artifact below, but verify reality in the workspace before editing.",
    `Original user request: ${userPrompt}`,
    `Planner goal: ${plan.goal}`,
    `Planner session ID: ${plannerSessionId ?? "not returned"}`,
    `Workspace summary: ${plan.workspaceSummary || "not provided"}`,
    `Reasoning summary: ${plan.reasoningSummary}`,
    "",
    "Findings:",
    ...(plan.findings.length ? plan.findings.map((item) => `- ${item}`) : ["- None recorded"]),
    "",
    "Risks:",
    ...(plan.risks.length ? plan.risks.map((item) => `- ${item}`) : ["- None recorded"]),
    "",
    "Execution steps:",
    steps,
    "",
    "Success criteria:",
    ...(plan.successCriteria.length ? plan.successCriteria.map((item) => `- ${item}`) : ["- Complete the requested work safely."]),
    "",
    "If the plan is stale or contradicted by the codebase, explain the mismatch clearly and proceed with the safest corrected implementation.",
  ].join("\n")
}

function createJsonLineCollector(onEvent) {
  let buffer = ""

  function flushLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      onEvent(JSON.parse(trimmed), line)
    } catch {
      onEvent({ type: "raw", raw: trimmed }, line)
    }
  }

  return {
    push(chunk) {
      buffer += chunk
      let newlineIndex = buffer.indexOf("\n")
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        flushLine(line)
        newlineIndex = buffer.indexOf("\n")
      }
    },
    end() {
      if (buffer.trim()) flushLine(buffer)
      buffer = ""
    },
  }
}

function summarizeEvents(events) {
  const textParts = []
  const errors = []
  const changedFiles = new Set()

  const collectPaths = (value, keyHint = "") => {
    if (!value) return

    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed) return
      if (/^[/~]/.test(trimmed) || /[\\/]/.test(trimmed) || /\.[a-z0-9]+$/i.test(trimmed)) {
        if (/(^|_)(file|path)s?$/i.test(keyHint) || /(^|_)(changed|edited)/i.test(keyHint) || /[\\/]/.test(trimmed)) {
          changedFiles.add(trimmed)
        }
      }
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) collectPaths(item, keyHint)
      return
    }

    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        collectPaths(nested, key)
      }
    }
  }

  for (const event of events) {
    if (event.type === "text" && typeof event.part?.text === "string") {
      textParts.push(event.part.text.trim())
    } else if (event.type === "error") {
      errors.push(event.error ?? event)
    }

    collectPaths(event)
  }

  return {
    finalText: textParts.filter(Boolean).join("\n\n"),
    errors,
    changedFiles: Array.from(changedFiles).sort(),
  }
}

export async function runOpencodeWorker({
  cwd,
  userPrompt,
  plan,
  plannerSessionId,
  workerModel,
  workerAgent,
  workerVariant,
  workerAutoApprove = true,
  commandSpec = getOpencodeCommandSpec(),
}) {
  const workerPrompt = createWorkerPrompt({
    userPrompt,
    plan,
    plannerSessionId,
  })

  const args = ["run", "--format", "json", "--dir", cwd]
  if (workerAgent) args.push("--agent", workerAgent)
  if (workerModel) args.push("--model", workerModel)
  if (workerVariant) args.push("--variant", workerVariant)
  if (workerAutoApprove) args.push("--dangerously-skip-permissions")

  const events = []
  const collector = createJsonLineCollector((event) => {
    events.push(event)
  })

  const result = await runCommand({
    commandSpec,
    args,
    cwd,
    input: workerPrompt,
    onStdout(chunk) {
      collector.push(chunk)
    },
  })
  collector.end()

  const summary = summarizeEvents(events)
  return {
    commandSpec,
    args,
    prompt: workerPrompt,
    events,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    ok: result.ok,
    finalText: summary.finalText,
    errors: summary.errors,
    changedFiles: summary.changedFiles,
    status: result.ok ? "completed" : "failed",
  }
}

export async function runOpencodePassthrough({ args, cwd, commandSpec = getOpencodeCommandSpec() }) {
  await runInherited({
    commandSpec,
    args,
    cwd,
  })
}
