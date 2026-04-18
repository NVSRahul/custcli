function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (value === undefined || value === null || value === "") return []
  return [String(value).trim()].filter(Boolean)
}

function uniqueStrings(values) {
  return Array.from(new Set(asArray(values)))
}

function clipText(text, limit = 180) {
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

function buildFindingDetails(review) {
  const typed = Array.isArray(review?.findingDetails) ? review.findingDetails : []
  if (typed.length > 0) return typed

  return asArray(review?.findings).map((item, index) => ({
    id: `finding-${index + 1}`,
    severity: "medium",
    summary: item,
    details: item,
    contradictionTarget: null,
    evidence: "",
    replanScope: [],
    verificationTarget: null,
  }))
}

function normalizeReplanScope({ finding, target }) {
  const explicit = uniqueStrings(finding?.replanScope)
  if (explicit.length > 0) return explicit
  if (!target) return ["plan"]
  return uniqueStrings([target.stepId, ...target.writeScope])
}

export function buildContradictions({ review, evidenceGraph, passNumber }) {
  const stepIndex = new Map(
    (Array.isArray(evidenceGraph?.stepEvidence) ? evidenceGraph.stepEvidence : []).map((item) => [item.stepId, item]),
  )

  const fallbackTarget = findFallbackTarget(evidenceGraph)
  const contradictions = []
  const findings = buildFindingDetails(review)

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
      resolution: "open",
      contradictionTarget: target?.stepId ?? null,
      verificationTarget: String(
        finding?.verificationTarget ??
          target?.verificationRules?.[0] ??
          target?.expectedEvidence?.[0] ??
          "",
      ).trim() || null,
      replanScope: normalizeReplanScope({ finding, target }),
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
      resolution: "open",
      contradictionTarget: target?.stepId ?? null,
      verificationTarget: String(target?.verificationRules?.[0] ?? target?.expectedEvidence?.[0] ?? "").trim() || null,
      replanScope: normalizeReplanScope({ finding: null, target }),
      passNumber,
    })
  }

  return contradictions
}

export function compactContradictions(contradictions) {
  return (Array.isArray(contradictions) ? contradictions : []).map((item) => ({
    id: String(item?.id ?? ""),
    severity: normalizeSeverity(item?.severity),
    claim: clipText(item?.claim, 160),
    evidence: clipText(item?.evidence, 180),
    source: String(item?.source ?? "unknown"),
    resolutionStatus: String(item?.resolutionStatus ?? item?.resolution ?? "open"),
    contradictionTarget: item?.contradictionTarget ?? null,
    verificationTarget: item?.verificationTarget ?? null,
    replanScope: uniqueStrings(item?.replanScope).slice(0, 6),
  }))
}

function stepMatchesScope(step, scopeSet) {
  if (scopeSet.size === 0) return false
  if (scopeSet.has(step.id)) return true
  return step.writeScope.some((item) => scopeSet.has(item))
}

export function scopePlanByContradictions({ plan, contradictions }) {
  const steps = Array.isArray(plan?.executionSteps) ? plan.executionSteps : []
  const scopeSet = new Set()

  for (const contradiction of Array.isArray(contradictions) ? contradictions : []) {
    if (contradiction?.contradictionTarget) scopeSet.add(String(contradiction.contradictionTarget))
    for (const scope of uniqueStrings(contradiction?.replanScope)) {
      scopeSet.add(scope)
    }
  }

  let affectedSteps = steps.filter((step) => stepMatchesScope(step, scopeSet))
  if (affectedSteps.length === 0) {
    affectedSteps = steps
  }

  const affectedIds = new Set(affectedSteps.map((step) => step.id))
  const preservedSteps = steps.filter((step) => !affectedIds.has(step.id))

  return {
    affectedSteps,
    preservedSteps,
    affectedStepIds: Array.from(affectedIds),
    summary:
      affectedSteps.length === steps.length
        ? "All plan steps are in scope for correction."
        : `Focus corrections on ${affectedSteps.length} contradicted step(s) and preserve the rest.`,
  }
}
