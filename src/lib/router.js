function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (value === undefined || value === null || value === "") return []
  return [String(value).trim()].filter(Boolean)
}

function clipText(text, limit = 180) {
  const value = String(text ?? "").trim()
  if (!value) return ""
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

function countSignals(items, threshold = 0) {
  const total = Array.isArray(items) ? items.length : 0
  return total > threshold ? 1 : 0
}

export function computeRoutingDecision({
  userPrompt,
  plan,
  reviewHistory = [],
  contradictions = [],
  plannerModel,
  workerModel,
}) {
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
      workerModel: workerModel ?? null,
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
    summary: clipText(
      `Routing selected ${reasoningIntensity} planning, ${reviewIntensity} review, and a ${complexityScore >= 4 ? "guided" : "direct"} execution strategy.`,
      220,
    ),
  }
}
