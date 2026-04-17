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

export function normalizeReview(review, rawResponse) {
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
  implementationSummary,
  changedFiles,
  testsRun,
  openQuestions,
  contradictions = [],
  planGoal,
  planSummary,
  cwd,
}) {
  const changed = changedFiles.length ? changedFiles.map((item) => `- ${item}`) : ["- None provided"]
  const tests = testsRun.length ? testsRun.map((item) => `- ${item}`) : ["- None provided"]
  const contradictionLines = contradictions.length
    ? contradictions.map(
        (item, index) =>
          `${index + 1}. claim=${item.claim}\n   evidence=${item.evidence}\n   source=${item.source}\n   resolution=${item.resolution}`,
      )
    : ["- None recorded"]

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
    "Planner goal:",
    planGoal || "Not provided",
    "",
    "Planner summary:",
    planSummary || "Not provided",
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
    "Concrete contradictions from prior passes:",
    ...contradictionLines,
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
    risks: asArray(review?.risks).slice(0, 5).map((item) => clipText(item, 180)),
    followUpSteps: asArray(review?.followUpSteps).slice(0, 5).map((item) => clipText(item, 180)),
    tests: asArray(review?.tests).slice(0, 5).map((item) => clipText(item, 160)),
  }
}
