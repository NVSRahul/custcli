import { appendKnowledgeRecord, loadRelevantKnowledge } from "./knowledge.js"
import { runOpencodeWorker } from "./opencode-adapter.js"
import { compactPlan } from "./plan.js"
import { getReasoningAdapter } from "./reasoning-adapter.js"
import { compactReview } from "./review.js"
import { createSessionStore } from "./session-store.js"

const MAX_CORRECTION_LOOPS = 1

function log(message, quiet) {
  if (!quiet) process.stderr.write(`${message}\n`)
}

function buildImplementationSummary({ worker, plan, passNumber }) {
  const sections = [
    `Execution pass: ${passNumber}`,
    `Plan goal: ${plan.goal}`,
    `Worker status: ${worker.status}`,
    `Worker output summary: ${worker.finalText || "No worker text output was captured."}`,
  ]

  if (worker.changedFiles?.length) {
    sections.push(`Changed files: ${worker.changedFiles.join(", ")}`)
  }

  if (worker.errors?.length) {
    sections.push(`Worker errors: ${worker.errors.map((item) => JSON.stringify(item)).join("; ")}`)
  }

  return sections.join("\n")
}

function buildContradictions({ review, worker, passNumber }) {
  const evidence = worker.finalText || `Worker status: ${worker.status}`
  return [
    ...review.findings.map((item) => ({
      claim: item,
      evidence,
      source: "gemini-review:finding",
      resolution: `pending-pass-${passNumber + 1}`,
    })),
    ...review.risks.map((item) => ({
      claim: item,
      evidence,
      source: "gemini-review:risk",
      resolution: `pending-pass-${passNumber + 1}`,
    })),
  ]
}

function buildReplanPrompt({ userPrompt, plan, review, contradictions, worker, passNumber }) {
  const contradictionBlock =
    contradictions.length === 0
      ? "- None recorded"
      : contradictions
          .map(
            (item, index) =>
              `${index + 1}. claim=${item.claim}\n   evidence=${item.evidence}\n   source=${item.source}\n   resolution=${item.resolution}`,
          )
          .join("\n")

  return [
    userPrompt,
    "",
    `This is correction planning pass ${passNumber + 1}.`,
    `Previous plan goal: ${plan.goal}`,
    `Previous plan summary: ${plan.reasoningSummary}`,
    `Latest worker summary: ${worker.finalText || "No worker output captured."}`,
    `Latest review verdict: ${review.verdict}`,
    `Latest review summary: ${review.summary}`,
    "",
    "Reviewer findings:",
    ...(review.findings.length ? review.findings.map((item) => `- ${item}`) : ["- None recorded"]),
    "",
    "Reviewer risks:",
    ...(review.risks.length ? review.risks.map((item) => `- ${item}`) : ["- None recorded"]),
    "",
    "Reviewer follow-up steps:",
    ...(review.followUpSteps.length ? review.followUpSteps.map((item) => `- ${item}`) : ["- None recorded"]),
    "",
    "Concrete contradictions to resolve:",
    contradictionBlock,
    "",
    "Produce a corrected plan that resolves the reviewer concerns. Keep the plan minimal and directly executable.",
  ].join("\n")
}

async function writePassArtifact(store, baseName, passNumber, value, writer = "writeJson") {
  const parsed = /^(.*?)(\.[^.]+)?$/.exec(baseName)
  const stem = parsed?.[1] ?? baseName
  const ext = parsed?.[2] ?? ""
  await store[writer](baseName, value)
  await store[writer](`${stem}-pass-${passNumber}${ext}`, value)
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
  const planner = await reasoning.runPlanner({
    cwd,
    userPrompt,
    plannerModel,
    plannerSession,
    plannerApprovalMode,
    knowledge,
  })
  const plannerCompact = compactPlan(planner.plan)

  await writePassArtifact(store, "planner-prompt.txt", 1, planner.prompt, "writeText")
  await writePassArtifact(store, "planner-stdout.json", 1, planner.stdout, "writeText")
  await writePassArtifact(store, "planner-stderr.log", 1, planner.stderr, "writeText")
  await writePassArtifact(store, "planner-envelope.json", 1, planner.envelope)
  await writePassArtifact(store, "plan.json", 1, planner.plan)
  await writePassArtifact(store, "plan-compact.json", 1, plannerCompact)

  let worker
  let finalPlanner = planner
  let finalPlannerCompact = plannerCompact
  let finalReview
  let finalReviewCompact
  const reviewHistory = []
  const contradictions = []

  if (!skipWorker) {
    for (let passNumber = 1; passNumber <= MAX_CORRECTION_LOOPS + 1; passNumber += 1) {
      log(`Executing plan with OpenCode (pass ${passNumber})`, quiet)
      worker = await runOpencodeWorker({
        cwd,
        userPrompt,
        plan: finalPlannerCompact,
        plannerSessionId: finalPlanner.plannerSessionId,
        workerModel,
        workerAgent,
        workerVariant,
        workerAutoApprove,
      })

      await writePassArtifact(store, "worker-prompt.txt", passNumber, worker.prompt, "writeText")
      await writePassArtifact(store, "worker-stdout.jsonl", passNumber, worker.stdout, "writeText")
      await writePassArtifact(store, "worker-stderr.log", passNumber, worker.stderr, "writeText")
      await writePassArtifact(store, "worker-events.json", passNumber, worker.events)

      log(`Reviewing execution with ${reasoning.provider} (pass ${passNumber})`, quiet)
      const implementationSummary = buildImplementationSummary({
        worker,
        plan: finalPlannerCompact,
        passNumber,
      })
      const review = await reasoning.runReviewer({
        cwd,
        request: userPrompt,
        implementationSummary,
        changedFiles: worker.changedFiles ?? [],
        testsRun: [],
        openQuestions:
          passNumber === 1
            ? "Review the initial implementation carefully."
            : `This is review pass ${passNumber} after follow-up changes. Approve only if the prior contradictions are resolved.`,
        contradictions,
        planGoal: finalPlannerCompact.goal,
        planSummary: finalPlannerCompact.reasoningSummary,
        plannerModel,
        plannerSession: finalPlanner.plannerSessionId,
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

      if (finalReviewCompact.verdict === "approved" || passNumber > MAX_CORRECTION_LOOPS) {
        break
      }

      const nextContradictions = buildContradictions({
        review: finalReviewCompact,
        worker,
        passNumber,
      })
      contradictions.push(...nextContradictions)
      await store.writeJson("contradictions.json", contradictions)
      await store.writeJson(`contradictions-pass-${passNumber}.json`, nextContradictions)

      log(`Re-planning after review feedback (pass ${passNumber + 1})`, quiet)
      finalPlanner = await reasoning.runPlanner({
        cwd,
        userPrompt: buildReplanPrompt({
          userPrompt,
          plan: finalPlannerCompact,
          review: finalReviewCompact,
          contradictions: nextContradictions,
          worker,
          passNumber,
        }),
        plannerModel,
        plannerSession: review.plannerSessionId ?? finalPlanner.plannerSessionId,
        plannerApprovalMode,
        knowledge,
      })
      finalPlannerCompact = compactPlan(finalPlanner.plan)

      await writePassArtifact(store, "planner-prompt.txt", passNumber + 1, finalPlanner.prompt, "writeText")
      await writePassArtifact(store, "planner-stdout.json", passNumber + 1, finalPlanner.stdout, "writeText")
      await writePassArtifact(store, "planner-stderr.log", passNumber + 1, finalPlanner.stderr, "writeText")
      await writePassArtifact(store, "planner-envelope.json", passNumber + 1, finalPlanner.envelope)
      await writePassArtifact(store, "plan.json", passNumber + 1, finalPlanner.plan)
      await writePassArtifact(store, "plan-compact.json", passNumber + 1, finalPlannerCompact)
    }
  }

  const summary = {
    runId: store.runId,
    mode,
    reasoningProvider: reasoning.provider,
    cwd,
    artifactDir: store.sessionDir,
    plannerSessionId: finalPlanner.plannerSessionId,
    plannerWarning: finalPlanner.fallbackNote ?? null,
    goal: finalPlannerCompact.goal,
    reasoningSummary: finalPlannerCompact.reasoningSummary,
    correctionLoopCount: Math.max(0, reviewHistory.length - 1),
    contradictionCount: contradictions.length,
    worker: worker
      ? {
          status: worker.status,
          code: worker.code,
          finalText: worker.finalText,
          errors: worker.errors,
          changedFiles: worker.changedFiles ?? [],
        }
      : undefined,
    review: finalReview
      ? {
          verdict: finalReviewCompact.verdict,
          summary: finalReviewCompact.summary,
          findings: finalReviewCompact.findings,
          risks: finalReviewCompact.risks,
          followUpSteps: finalReviewCompact.followUpSteps,
        }
      : undefined,
  }

  await store.writeJson("summary.json", summary)
  if (contradictions.length) {
    await store.writeJson("contradictions.json", contradictions)
  }
  if (reviewHistory.length) {
    await store.writeJson("review-history.json", reviewHistory)
  }

  await appendKnowledgeRecord({
    rootDir: store.rootDir,
    record: {
      runId: store.runId,
      cwd,
      prompt: userPrompt,
      goal: finalPlannerCompact.goal,
      reasoningSummary: finalReviewCompact?.summary ?? finalPlannerCompact.reasoningSummary,
      plannerSessionId: finalPlanner.plannerSessionId,
      workerStatus: finalReviewCompact?.verdict ?? worker?.status ?? "skipped",
      createdAt: store.createdAt,
      artifactDir: store.sessionDir,
    },
  })

  log(`Artifacts saved to ${store.sessionDir}`, quiet)
  return {
    store,
    planner: finalPlanner,
    worker,
    review: finalReview,
    summary,
  }
}
