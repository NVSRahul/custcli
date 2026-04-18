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

function countEventTypes(events = []) {
  const counts = {}
  for (const event of Array.isArray(events) ? events : []) {
    const type = String(event?.type ?? "unknown").trim() || "unknown"
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

function normalizeChangedFiles(files) {
  return uniqueStrings(files)
    .map((item) => item.replace(/^~\//, ""))
    .sort()
}

function normalizeObservedFailures(worker) {
  const errors = Array.isArray(worker?.errors) ? worker.errors : []
  const normalized = errors.map((item) => {
    if (typeof item === "string") return item.trim()
    if (item?.message) return String(item.message).trim()
    return JSON.stringify(item)
  })

  if (worker?.code && worker.code !== 0) {
    normalized.push(`Worker exited with code ${worker.code}.`)
  }
  if (worker?.status === "failed") {
    normalized.push("Worker reported failed status.")
  }

  return uniqueStrings(normalized)
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

function buildStepEvidence({ step, worker, changedFiles, failures, eventTypeCounts }) {
  const writeScopeMatches = changedFiles.filter((filePath) => step.writeScope.some((scope) => pathMatchesScope(filePath, scope)))
  const claimMatches = pickMatchedItems(step.claims, worker.finalText, 2)
  const expectedMatches = pickMatchedItems(step.expectedEvidence, worker.finalText, 2)
  const verificationMatches = pickMatchedItems(step.verificationRules, worker.finalText, 2)
  const verificationStatus = deriveVerificationStatus({
    failures,
    writeScopeMatches,
    claimMatches,
    expectedMatches,
    verificationMatches,
  })

  const observedEvidence = uniqueStrings([
    ...writeScopeMatches.map((item) => `changed:${item}`),
    ...claimMatches.map((item) => `claim:${clipText(item, 120)}`),
    ...expectedMatches.map((item) => `expected:${clipText(item, 120)}`),
    ...verificationMatches.map((item) => `verify:${clipText(item, 120)}`),
    worker.status ? `worker_status:${worker.status}` : "",
    eventTypeCounts.text ? `event:text:${eventTypeCounts.text}` : "",
    eventTypeCounts.error ? `event:error:${eventTypeCounts.error}` : "",
  ])

  const missingEvidence = step.expectedEvidence.filter((item) => !expectedMatches.includes(item))

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
    observedEvidence,
    missingEvidence,
    verificationStatus,
  }
}

export function createEvidenceGraph({
  plan,
  worker,
  passNumber,
  plannerSessionId,
  request,
}) {
  const changedFiles = normalizeChangedFiles(worker?.changedFiles)
  const failures = normalizeObservedFailures(worker)
  const eventTypeCounts = countEventTypes(worker?.events)
  const steps = Array.isArray(plan?.executionSteps) ? plan.executionSteps : []
  const stepEvidence = steps.map((step) =>
    buildStepEvidence({
      step,
      worker,
      changedFiles,
      failures,
      eventTypeCounts,
    }),
  )

  const verifiedStepCount = stepEvidence.filter((item) => item.verificationStatus === "verified").length
  const partialStepCount = stepEvidence.filter((item) => item.verificationStatus === "partial").length
  const missingStepCount = stepEvidence.filter((item) => item.verificationStatus === "missing").length
  const blockedStepCount = stepEvidence.filter((item) => item.verificationStatus === "blocked").length

  const summary = [
    `Execution pass ${passNumber}`,
    `Worker status: ${worker?.status ?? "unknown"}`,
    `Changed files: ${changedFiles.length}`,
    `Verified steps: ${verifiedStepCount}/${stepEvidence.length}`,
    failures.length ? `Observed failures: ${failures.length}` : "Observed failures: 0",
  ].join(" | ")

  return {
    schemaVersion: 1,
    request: String(request ?? "").trim(),
    passNumber,
    plannerSessionId: plannerSessionId ?? null,
    goal: String(plan?.goal ?? "Complete the requested work"),
    commandResult: {
      status: worker?.status ?? "unknown",
      code: worker?.code ?? null,
      ok: Boolean(worker?.ok),
    },
    changedFiles,
    observedFailures: failures,
    eventTypeCounts,
    finalText: String(worker?.finalText ?? "").trim(),
    stepEvidence,
    verifiedStepCount,
    partialStepCount,
    missingStepCount,
    blockedStepCount,
    summary,
  }
}

export function compactEvidenceGraph(graph) {
  return {
    schemaVersion: graph?.schemaVersion ?? 1,
    passNumber: graph?.passNumber ?? 1,
    goal: clipText(graph?.goal, 180),
    commandResult: {
      status: String(graph?.commandResult?.status ?? "unknown"),
      code: graph?.commandResult?.code ?? null,
      ok: Boolean(graph?.commandResult?.ok),
    },
    changedFiles: normalizeChangedFiles(graph?.changedFiles).slice(0, 12),
    observedFailures: uniqueStrings(graph?.observedFailures).slice(0, 8).map((item) => clipText(item, 160)),
    eventTypeCounts: graph?.eventTypeCounts ?? {},
    finalText: clipText(graph?.finalText, 320),
    verifiedStepCount: Number(graph?.verifiedStepCount ?? 0),
    partialStepCount: Number(graph?.partialStepCount ?? 0),
    missingStepCount: Number(graph?.missingStepCount ?? 0),
    blockedStepCount: Number(graph?.blockedStepCount ?? 0),
    summary: clipText(graph?.summary, 220),
    stepEvidence: (Array.isArray(graph?.stepEvidence) ? graph.stepEvidence : []).map((item) => ({
      stepId: String(item?.stepId ?? ""),
      title: clipText(item?.title, 120),
      verificationStatus: String(item?.verificationStatus ?? "missing"),
      writeScopeMatches: normalizeChangedFiles(item?.writeScopeMatches).slice(0, 6),
      observedEvidence: uniqueStrings(item?.observedEvidence).slice(0, 6).map((entry) => clipText(entry, 140)),
      missingEvidence: uniqueStrings(item?.missingEvidence).slice(0, 4).map((entry) => clipText(entry, 140)),
    })),
  }
}
