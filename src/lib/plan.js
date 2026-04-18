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

function clipText(text, limit = 240) {
  const value = String(text ?? "").trim()
  if (!value) return ""
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

function normalizeStep(step, index, globals) {
  const title = String(step?.title ?? step?.name ?? `Step ${index + 1}`)
  const description = String(step?.description ?? step?.details ?? step?.prompt ?? "")
  const doneWhen = asArray(step?.doneWhen ?? step?.success_criteria)
  const claims = uniqueStrings(step?.claims ?? step?.claim ?? doneWhen ?? [`Complete ${title}`])
  const expectedEvidence = uniqueStrings(step?.expectedEvidence ?? step?.expected_evidence ?? doneWhen)
  const writeScope = uniqueStrings(step?.writeScope ?? step?.write_scope ?? step?.paths ?? step?.files)
  const verificationRules = uniqueStrings(
    step?.verificationRules ?? step?.verification_rules ?? step?.verification_rule ?? doneWhen ?? globals.successCriteria,
  )
  const fallback = uniqueStrings(
    step?.fallback ?? step?.fallback_steps ?? step?.fallbackSteps ?? globals.replanTriggers,
  )

  return {
    id: String(step?.id ?? `step-${index + 1}`),
    title,
    goal: String(step?.goal ?? title),
    description,
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

export function machineCheckPlan(plan) {
  const issues = []
  const warnings = []
  const steps = Array.isArray(plan?.executionSteps) ? plan.executionSteps : []
  const ids = new Set()

  for (const step of steps) {
    if (ids.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}" remained after normalization.`)
    }
    ids.add(step.id)
    if (!step.opencodePrompt.trim()) {
      issues.push(`Step "${step.id}" is missing an execution prompt.`)
    }
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

export function normalizePlan(plan, rawResponse) {
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

export function compactPlan(plan) {
  return {
    goal: clipText(plan?.goal, 220) || "Complete the requested work",
    workspaceSummary: clipText(plan?.workspaceSummary, 320),
    reasoningSummary: clipText(plan?.reasoningSummary, 320),
    decisionLog: asArray(plan?.decisionLog).slice(0, 5).map((item) => clipText(item, 180)),
    findings: asArray(plan?.findings).slice(0, 5).map((item) => clipText(item, 180)),
    assumptions: asArray(plan?.assumptions).slice(0, 5).map((item) => clipText(item, 180)),
    risks: asArray(plan?.risks).slice(0, 5).map((item) => clipText(item, 180)),
    planClaims: uniqueStrings(plan?.planClaims).slice(0, 6).map((item) => clipText(item, 180)),
    executionSteps: (Array.isArray(plan?.executionSteps) ? plan.executionSteps : []).map((step, index) => ({
      id: String(step?.id ?? `step-${index + 1}`),
      title: clipText(step?.title ?? `Step ${index + 1}`, 140),
      goal: clipText(step?.goal ?? step?.title ?? `Step ${index + 1}`, 160),
      description: clipText(step?.description ?? "", 220),
      opencodePrompt: clipText(step?.opencodePrompt ?? "", 320),
      dependsOn: asArray(step?.dependsOn).slice(0, 5).map((item) => clipText(item, 120)),
      doneWhen: asArray(step?.doneWhen).slice(0, 5).map((item) => clipText(item, 140)),
      claims: asArray(step?.claims).slice(0, 5).map((item) => clipText(item, 140)),
      expectedEvidence: asArray(step?.expectedEvidence).slice(0, 5).map((item) => clipText(item, 140)),
      writeScope: asArray(step?.writeScope).slice(0, 5).map((item) => clipText(item, 120)),
      verificationRules: asArray(step?.verificationRules).slice(0, 5).map((item) => clipText(item, 140)),
      fallback: asArray(step?.fallback).slice(0, 5).map((item) => clipText(item, 140)),
    })),
    replanTriggers: asArray(plan?.replanTriggers).slice(0, 5).map((item) => clipText(item, 160)),
    successCriteria: asArray(plan?.successCriteria).slice(0, 5).map((item) => clipText(item, 180)),
    machineCheck: {
      readyForExecution: Boolean(plan?.machineCheck?.readyForExecution),
      issues: asArray(plan?.machineCheck?.issues).slice(0, 5).map((item) => clipText(item, 160)),
      warnings: asArray(plan?.machineCheck?.warnings).slice(0, 5).map((item) => clipText(item, 160)),
      checks: Array.isArray(plan?.machineCheck?.checks)
        ? plan.machineCheck.checks.map((item) => ({
            name: String(item?.name ?? ""),
            ok: Boolean(item?.ok),
          }))
        : [],
    },
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
