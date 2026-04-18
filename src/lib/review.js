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

function clipText(text, limit = 220) {
  const value = String(text ?? "").trim()
  if (!value) return ""
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

function normalizeSeverity(value) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized
  }
  return "medium"
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

export function normalizeReview(review, rawResponse) {
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
    normalized.summary = normalized.findings[0] ?? "Reviewer returned no summary."
  }

  return normalized
}

export function extractReview(responseText) {
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
      risks: ["Reviewer returned non-JSON output."],
      follow_up_steps: ["Review the raw reviewer artifact before concluding."],
      tests: [],
    },
    responseText,
  )
}

export function createReviewPrompt({
  request,
  compactPlan,
  compactEvidence,
  testsRun,
  openQuestions,
  contradictions = [],
  routing,
  cwd,
}) {
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

export function compactReview(review) {
  return {
    verdict: String(review?.verdict ?? "needs_followup"),
    summary: clipText(review?.summary, 320),
    findings: asArray(review?.findings).slice(0, 5).map((item) => clipText(item, 180)),
    findingDetails: (Array.isArray(review?.findingDetails) ? review.findingDetails : []).slice(0, 5).map((item) => ({
      id: String(item?.id ?? ""),
      severity: normalizeSeverity(item?.severity),
      summary: clipText(item?.summary, 180),
      contradictionTarget: item?.contradictionTarget ?? null,
      verificationTarget: item?.verificationTarget ?? null,
      replanScope: asArray(item?.replanScope).slice(0, 5).map((entry) => clipText(entry, 120)),
    })),
    risks: asArray(review?.risks).slice(0, 5).map((item) => clipText(item, 180)),
    followUpSteps: asArray(review?.followUpSteps).slice(0, 5).map((item) => clipText(item, 180)),
    tests: asArray(review?.tests).slice(0, 5).map((item) => clipText(item, 160)),
  }
}
