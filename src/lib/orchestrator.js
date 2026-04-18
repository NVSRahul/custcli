import { buildContradictions, compactContradictions, scopePlanByContradictions } from "./contradiction.js"
import { createEvidenceGraph, compactEvidenceGraph } from "./evidence.js"
import { appendKnowledgeRecord, loadRelevantKnowledge } from "./knowledge.js"
import { runOpencodeWorker } from "./opencode-adapter.js"
import { compactPlan } from "./plan.js"
import { compilePromotions, buildMemoryTiers, persistPromotions } from "./promotion.js"
import { getReasoningAdapter } from "./reasoning-adapter.js"
import { compactReview } from "./review.js"
import { computeRoutingDecision } from "./router.js"
import { createSessionStore } from "./session-store.js"

const HARD_MAX_CORRECTION_LOOPS = 2

function log(message, quiet) {
  if (!quiet) process.stderr.write(`${message}\n`)
}

function flattenFindingSummaries(review) {
  return Array.isArray(review?.findings) ? review.findings : []
}

function buildReviewFocus({ passNumber, routing, contradictions, evidenceCompact }) {
  const emphasis = routing?.reasoning?.reviewIntensity ?? "baseline"
  const contradictionNote =
    contradictions.length === 0
      ? "No prior contradictions are open."
      : `Resolve ${contradictions.length} open contradiction(s) before approving the run.`

  return [
    `Review pass ${passNumber}.`,
    `Review intensity: ${emphasis}.`,
    contradictionNote,
    `Evidence summary: ${evidenceCompact?.summary ?? "No compact evidence was recorded."}`,
  ].join(" ")
}

function buildScopedReplanPrompt({
  userPrompt,
  planCompact,
  reviewCompact,
  evidenceCompact,
  contradictions,
  scope,
  routing,
  passNumber,
}) {
  return [
    userPrompt,
    "",
    `This is correction planning pass ${passNumber + 1}.`,
    "Use the structured contradiction packet below. Preserve unaffected steps unless there is a concrete reason to change them.",
    "",
    "Routing context:",
    JSON.stringify(routing, null, 2),
    "",
    "Previous compact plan:",
    JSON.stringify(planCompact, null, 2),
    "",
    "Previous compact review:",
    JSON.stringify(reviewCompact, null, 2),
    "",
    "Previous compact evidence graph:",
    JSON.stringify(evidenceCompact, null, 2),
    "",
    "Concrete contradictions:",
    JSON.stringify(compactContradictions(contradictions), null, 2),
    "",
    "Scoped correction slice:",
    JSON.stringify(
      {
        summary: scope.summary,
        affectedSteps: scope.affectedSteps,
        preservedSteps: scope.preservedSteps.map((step) => ({
          id: step.id,
          title: step.title,
          writeScope: step.writeScope,
        })),
      },
      null,
      2,
    ),
    "",
    "Return a corrected plan that focuses on contradicted slices, keeps context compact, and leaves preserved steps intact unless a dependency forces change.",
  ].join("\n")
}

async function writePassArtifact(store, baseName, passNumber, value, writer = "writeJson") {
  const parsed = /^(.*?)(\.[^.]+)?$/.exec(baseName)
  const stem = parsed?.[1] ?? baseName
  const ext = parsed?.[2] ?? ""
  await store[writer](baseName, value)
  await store[writer](`${stem}-pass-${passNumber}${ext}`, value)
}

function buildColdArtifactIndex() {
  return {
    raw: [
      "planner-prompt.txt",
      "planner-stdout.json",
      "planner-stderr.log",
      "planner-envelope.json",
      "review-prompt.txt",
      "review-stdout.json",
      "review-stderr.log",
      "review-envelope.json",
      "worker-prompt.txt",
      "worker-stdout.jsonl",
      "worker-stderr.log",
      "worker-events.json",
    ],
    structured: [
      "request.json",
      "summary.json",
      "plan.json",
      "plan-compact.json",
      "plan-validation.json",
      "review.json",
      "review-compact.json",
      "evidence-graph.json",
      "evidence-compact.json",
      "contradictions.json",
      "review-history.json",
      "routing.json",
      "promotions.json",
      "memory-hot.json",
      "memory-warm.json",
      "memory-cold.json",
      "memory-learned.json",
    ],
  }
}

export async function runOrchestration({
  mode,
  userPrompt,
  cwd,
  plannerModel,
  plannerSession,
  workerModel,
  workerAgent,
  workerVariant,
  plannerApprovalMode = "plan",
  artifactRoot,
  skipWorker = false,
  workerAutoApprove = true,
  outputJson = false,
  quiet = false,
}) {
  const reasoning = getReasoningAdapter()
  const store = await createSessionStore({
    cwd,
    artifactRoot,
  })

  const knowledge = await loadRelevantKnowledge({
    rootDir: store.rootDir,
    prompt: userPrompt,
    cwd,
  })

  await store.writeJson("request.json", {
    mode,
    reasoningProvider: reasoning.provider,
    cwd,
    userPrompt,
    plannerModel,
    plannerSession,
    workerModel,
    workerAgent,
    workerVariant,
    plannerApprovalMode,
    skipWorker,
    workerAutoApprove,
    outputJson,
    createdAt: store.createdAt,
  })

  log(`Planning with ${reasoning.provider} in ${cwd}`, quiet)
  let planner = await reasoning.runPlanner({
    cwd,
    userPrompt,
    plannerModel,
    plannerSession,
    plannerApprovalMode,
    knowledge,
  })
  let plannerCompact = compactPlan(planner.plan)

  await writePassArtifact(store, "planner-prompt.txt", 1, planner.prompt, "writeText")
  await writePassArtifact(store, "planner-stdout.json", 1, planner.stdout, "writeText")
  await writePassArtifact(store, "planner-stderr.log", 1, planner.stderr, "writeText")
  await writePassArtifact(store, "planner-envelope.json", 1, planner.envelope)
  await writePassArtifact(store, "plan.json", 1, planner.plan)
  await writePassArtifact(store, "plan-compact.json", 1, plannerCompact)
  await writePassArtifact(store, "plan-validation.json", 1, planner.plan.machineCheck)

  let routing = computeRoutingDecision({
    userPrompt,
    plan: plannerCompact,
    reviewHistory: [],
    contradictions: [],
    plannerModel,
    workerModel,
  })
  await writePassArtifact(store, "routing.json", 1, routing)

  let worker
  let finalReview
  let finalReviewCompact
  let finalEvidenceGraph
  let finalEvidenceCompact
  let finalRouting = routing
  const reviewHistory = []
  const contradictions = []
  const loopBudget = Math.min(HARD_MAX_CORRECTION_LOOPS, Math.max(0, routing.reasoning.loopBudget))

  if (!skipWorker) {
    for (let passNumber = 1; passNumber <= loopBudget + 1; passNumber += 1) {
      log(`Executing plan with OpenCode (pass ${passNumber})`, quiet)
      worker = await runOpencodeWorker({
        cwd,
        userPrompt,
        plan: plannerCompact,
        plannerSessionId: planner.plannerSessionId,
        workerModel,
        workerAgent,
        workerVariant,
        workerAutoApprove,
      })

      await writePassArtifact(store, "worker-prompt.txt", passNumber, worker.prompt, "writeText")
      await writePassArtifact(store, "worker-stdout.jsonl", passNumber, worker.stdout, "writeText")
      await writePassArtifact(store, "worker-stderr.log", passNumber, worker.stderr, "writeText")
      await writePassArtifact(store, "worker-events.json", passNumber, worker.events)

      const evidenceGraph = createEvidenceGraph({
        plan: planner.plan,
        worker,
        passNumber,
        plannerSessionId: planner.plannerSessionId,
        request: userPrompt,
      })
      const evidenceCompact = compactEvidenceGraph(evidenceGraph)
      finalEvidenceGraph = evidenceGraph
      finalEvidenceCompact = evidenceCompact

      await writePassArtifact(store, "evidence-graph.json", passNumber, evidenceGraph)
      await writePassArtifact(store, "evidence-compact.json", passNumber, evidenceCompact)

      finalRouting = computeRoutingDecision({
        userPrompt,
        plan: plannerCompact,
        reviewHistory,
        contradictions,
        plannerModel,
        workerModel,
      })
      await writePassArtifact(store, "routing.json", passNumber, finalRouting)

      log(`Reviewing execution with ${reasoning.provider} (pass ${passNumber})`, quiet)
      const review = await reasoning.runReviewer({
        cwd,
        request: userPrompt,
        compactPlan: plannerCompact,
        compactEvidence: evidenceCompact,
        testsRun: [],
        openQuestions: buildReviewFocus({
          passNumber,
          routing: finalRouting,
          contradictions,
          evidenceCompact,
        }),
        contradictions: compactContradictions(contradictions),
        routing: finalRouting,
        plannerModel,
        plannerSession: planner.plannerSessionId,
        plannerApprovalMode,
      })

      finalReview = review
      finalReviewCompact = compactReview(review.review)
      reviewHistory.push(finalReviewCompact)

      await writePassArtifact(store, "review-prompt.txt", passNumber, review.prompt, "writeText")
      await writePassArtifact(store, "review-stdout.json", passNumber, review.stdout, "writeText")
      await writePassArtifact(store, "review-stderr.log", passNumber, review.stderr, "writeText")
      await writePassArtifact(store, "review-envelope.json", passNumber, review.envelope)
      await writePassArtifact(store, "review.json", passNumber, review.review)
      await writePassArtifact(store, "review-compact.json", passNumber, finalReviewCompact)

      if (finalReviewCompact.verdict === "approved" || passNumber > loopBudget) {
        break
      }

      const nextContradictions = buildContradictions({
        review: review.review,
        evidenceGraph,
        passNumber,
      })
      contradictions.push(...nextContradictions)
      await store.writeJson("contradictions.json", contradictions)
      await store.writeJson(`contradictions-pass-${passNumber}.json`, nextContradictions)

      const scope = scopePlanByContradictions({
        plan: planner.plan,
        contradictions: nextContradictions,
      })

      log(`Re-planning after structured review feedback (pass ${passNumber + 1})`, quiet)
      planner = await reasoning.runPlanner({
        cwd,
        userPrompt: buildScopedReplanPrompt({
          userPrompt,
          planCompact: plannerCompact,
          reviewCompact: finalReviewCompact,
          evidenceCompact,
          contradictions: nextContradictions,
          scope,
          routing: finalRouting,
          passNumber,
        }),
        plannerModel,
        plannerSession: review.plannerSessionId ?? planner.plannerSessionId,
        plannerApprovalMode,
        knowledge,
      })
      plannerCompact = compactPlan(planner.plan)

      await writePassArtifact(store, "planner-prompt.txt", passNumber + 1, planner.prompt, "writeText")
      await writePassArtifact(store, "planner-stdout.json", passNumber + 1, planner.stdout, "writeText")
      await writePassArtifact(store, "planner-stderr.log", passNumber + 1, planner.stderr, "writeText")
      await writePassArtifact(store, "planner-envelope.json", passNumber + 1, planner.envelope)
      await writePassArtifact(store, "plan.json", passNumber + 1, planner.plan)
      await writePassArtifact(store, "plan-compact.json", passNumber + 1, plannerCompact)
      await writePassArtifact(store, "plan-validation.json", passNumber + 1, planner.plan.machineCheck)
    }
  }

  if (contradictions.length) {
    await store.writeJson("contradictions.json", contradictions)
  }
  if (reviewHistory.length) {
    await store.writeJson("review-history.json", reviewHistory)
  }

  const promotions = await compilePromotions({
    rootDir: store.rootDir,
    cwd,
    prompt: userPrompt,
    plan: planner.plan,
    review: finalReview?.review ?? finalReviewCompact,
    evidenceGraph: finalEvidenceGraph,
    contradictions,
    routing: finalRouting,
  })
  const promoted = await persistPromotions({
    rootDir: store.rootDir,
    cwd,
    runId: store.runId,
    promotions,
  })

  await store.writeJson("promotions.json", {
    ...promotions,
    promoted,
  })

  const memoryTiers = buildMemoryTiers({
    plan: planner.plan,
    planCompact: plannerCompact,
    review: finalReview?.review ?? null,
    reviewCompact: finalReviewCompact ?? null,
    evidenceGraph: finalEvidenceGraph ?? null,
    evidenceCompact: finalEvidenceCompact ?? null,
    contradictions: compactContradictions(contradictions),
    promotions: {
      ...promotions,
      promoted,
    },
    knowledge,
    routing: finalRouting,
    artifacts: buildColdArtifactIndex(),
  })

  await store.writeJson("memory-hot.json", memoryTiers.hot)
  await store.writeJson("memory-warm.json", memoryTiers.warm)
  await store.writeJson("memory-cold.json", memoryTiers.cold)
  await store.writeJson("memory-learned.json", memoryTiers.learned)

  const summary = {
    runId: store.runId,
    mode,
    reasoningProvider: reasoning.provider,
    cwd,
    artifactDir: store.sessionDir,
    plannerSessionId: planner.plannerSessionId,
    plannerWarning: planner.fallbackNote ?? null,
    goal: plannerCompact.goal,
    reasoningSummary: plannerCompact.reasoningSummary,
    correctionLoopCount: Math.max(0, reviewHistory.length - 1),
    contradictionCount: contradictions.length,
    routing: {
      complexityScore: finalRouting.complexityScore,
      reasoningIntensity: finalRouting.reasoning.intensity,
      reviewIntensity: finalRouting.reasoning.reviewIntensity,
      loopBudget: finalRouting.reasoning.loopBudget,
    },
    evidence: finalEvidenceCompact
      ? {
          summary: finalEvidenceCompact.summary,
          verifiedStepCount: finalEvidenceCompact.verifiedStepCount,
          partialStepCount: finalEvidenceCompact.partialStepCount,
          missingStepCount: finalEvidenceCompact.missingStepCount,
          blockedStepCount: finalEvidenceCompact.blockedStepCount,
          changedFiles: finalEvidenceCompact.changedFiles,
        }
      : undefined,
    promotions: {
      candidateCount: promotions.candidates.length,
      promotedCount: promoted.length,
    },
    worker: worker
      ? {
          status: worker.status,
          code: worker.code,
          finalText: worker.finalText,
          errors: worker.errors,
          changedFiles: worker.changedFiles ?? [],
        }
      : undefined,
    review: finalReviewCompact
      ? {
          verdict: finalReviewCompact.verdict,
          summary: finalReviewCompact.summary,
          findings: flattenFindingSummaries(finalReviewCompact),
          findingDetails: finalReviewCompact.findingDetails ?? [],
          risks: finalReviewCompact.risks,
          followUpSteps: finalReviewCompact.followUpSteps,
        }
      : undefined,
  }

  await store.writeJson("summary.json", summary)

  await appendKnowledgeRecord({
    rootDir: store.rootDir,
    record: {
      runId: store.runId,
      cwd,
      prompt: userPrompt,
      goal: plannerCompact.goal,
      reasoningSummary: finalReviewCompact?.summary ?? plannerCompact.reasoningSummary,
      plannerSessionId: planner.plannerSessionId,
      workerStatus: finalReviewCompact?.verdict ?? worker?.status ?? "skipped",
      reviewVerdict: finalReviewCompact?.verdict ?? null,
      contradictionCount: contradictions.length,
      correctionLoopCount: Math.max(0, reviewHistory.length - 1),
      planClaims: plannerCompact.planClaims,
      promotedCount: promoted.length,
      createdAt: store.createdAt,
      artifactDir: store.sessionDir,
    },
  })

  log(`Artifacts saved to ${store.sessionDir}`, quiet)
  return {
    store,
    planner,
    worker,
    review: finalReview,
    summary,
  }
}
