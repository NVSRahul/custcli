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

function clipText(text, limit = 240) {
  const value = String(text ?? "").trim()
  if (!value) return ""
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
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

export function createPlannerPrompt({ userPrompt, cwd, knowledge = [] }) {
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

export function normalizePlan(plan, rawResponse) {
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

export function compactPlan(plan) {
  return {
    goal: clipText(plan?.goal, 220) || "Complete the requested work",
    workspaceSummary: clipText(plan?.workspaceSummary, 320),
    reasoningSummary: clipText(plan?.reasoningSummary, 320),
    decisionLog: asArray(plan?.decisionLog).slice(0, 5).map((item) => clipText(item, 180)),
    findings: asArray(plan?.findings).slice(0, 5).map((item) => clipText(item, 180)),
    assumptions: asArray(plan?.assumptions).slice(0, 5).map((item) => clipText(item, 180)),
    risks: asArray(plan?.risks).slice(0, 5).map((item) => clipText(item, 180)),
    executionSteps: (Array.isArray(plan?.executionSteps) ? plan.executionSteps : []).map((step, index) => ({
      id: String(step?.id ?? `step-${index + 1}`),
      title: clipText(step?.title ?? `Step ${index + 1}`, 140),
      description: clipText(step?.description ?? "", 220),
      opencodePrompt: clipText(step?.opencodePrompt ?? "", 320),
      dependsOn: asArray(step?.dependsOn).slice(0, 5).map((item) => clipText(item, 120)),
      doneWhen: asArray(step?.doneWhen).slice(0, 5).map((item) => clipText(item, 140)),
    })),
    replanTriggers: asArray(plan?.replanTriggers).slice(0, 5).map((item) => clipText(item, 160)),
    successCriteria: asArray(plan?.successCriteria).slice(0, 5).map((item) => clipText(item, 180)),
  }
}

export function extractPlan(responseText) {
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
        },
      ],
      replan_triggers: ["Worker reports ambiguity or plan mismatch."],
      success_criteria: ["Requested work is implemented and verified."],
    },
    responseText,
  )
}
