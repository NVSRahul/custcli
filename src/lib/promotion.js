import path from "node:path"
import { appendJsonl, readJsonl } from "./session-store.js"

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

function uniqueStrings(values) {
  return Array.from(new Set(asArray(values)))
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
}

function overlapScore(left, right) {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  let score = 0
  for (const item of a) {
    if (b.has(item)) score += 1
  }
  return score
}

async function loadExecutionHistory({ rootDir, cwd, limit = 40 }) {
  const filePath = path.join(rootDir, "knowledge", "executions.jsonl")
  const records = await readJsonl(filePath)
  return records.filter((item) => item.cwd === cwd).slice(-limit)
}

function buildGateState({ validated, repeated, usefulAcrossSessions, improvesEvals }) {
  return {
    validated: Boolean(validated),
    repeated: Boolean(repeated),
    usefulAcrossSessions: Boolean(usefulAcrossSessions),
    improvesEvals: Boolean(improvesEvals),
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

export async function compilePromotions({
  rootDir,
  cwd,
  prompt,
  plan,
  review,
  evidenceGraph,
  contradictions,
  routing,
}) {
  const history = await loadExecutionHistory({ rootDir, cwd })
  const historyMatches = history.filter(
    (item) => overlapScore(prompt, [item.prompt, item.goal, item.reasoningSummary].filter(Boolean).join(" ")) >= 3,
  )
  const successfulMatches = historyMatches.filter((item) => item.workerStatus === "approved" || item.workerStatus === "completed")

  const candidates = []
  const validated = review?.verdict === "approved"
  const contradictionCount = Array.isArray(contradictions) ? contradictions.length : 0
  const recurring = successfulMatches.length >= 1

  if (validated) {
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
          gates: buildGateState({
            validated,
            repeated: recurring,
            usefulAcrossSessions: verificationTemplate.length >= 2,
            improvesEvals: recurring && contradictionCount === 0,
          }),
        }),
      )
    }
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
        gates: buildGateState({
          validated,
          repeated: recurring || contradictionCount > 0,
          usefulAcrossSessions: true,
          improvesEvals: validated && (recurring || contradictionCount === 0),
        }),
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
        gates: buildGateState({
          validated,
          repeated: recurring,
          usefulAcrossSessions: reusableScopes.length >= 1,
          improvesEvals: recurring && contradictionCount === 0,
        }),
      }),
    )
  }

  const promoted = candidates.filter((item) => item.decision === "promote")
  return {
    historySummary: {
      comparedRuns: history.length,
      similarRuns: historyMatches.length,
      successfulSimilarRuns: successfulMatches.length,
    },
    candidates,
    promoted,
  }
}

export async function persistPromotions({ rootDir, cwd, runId, promotions }) {
  const promoted = Array.isArray(promotions?.promoted) ? promotions.promoted : []
  if (promoted.length === 0) return []

  const filePath = path.join(rootDir, "knowledge", "promotions.jsonl")
  const persisted = []
  for (const item of promoted) {
    const record = {
      ...item,
      cwd,
      runId,
      createdAt: new Date().toISOString(),
    }
    await appendJsonl(filePath, record)
    persisted.push(record)
  }
  return persisted
}

export function buildMemoryTiers({
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
        goal: clipText(item.goal, 160),
        reasoningSummary: clipText(item.reasoningSummary, 180),
        workerStatus: item.workerStatus,
        artifactDir: item.artifactDir,
      })),
      promotionCandidates: Array.isArray(promotions?.candidates) ? promotions.candidates : [],
      currentSignals: {
        planGoal: clipText(plan?.goal, 160),
        reviewVerdict: review?.verdict ?? null,
      },
    },
    cold: {
      accessMode: "read_on_demand",
      artifacts,
      summary: clipText(evidenceGraph?.summary ?? review?.summary ?? plan?.reasoningSummary, 220),
    },
    learned: {
      promoted: Array.isArray(promotions?.promoted) ? promotions.promoted : [],
      policyCount: (Array.isArray(promotions?.promoted) ? promotions.promoted : []).filter((item) => item.type === "policy").length,
      routingRuleCount: (Array.isArray(promotions?.promoted) ? promotions.promoted : []).filter((item) => item.type === "routing_rule").length,
      verificationTemplateCount: (Array.isArray(promotions?.promoted) ? promotions.promoted : []).filter((item) => item.type === "verification_template").length,
    },
  }
}
