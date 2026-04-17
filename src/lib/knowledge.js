import path from "node:path"
import { appendJsonl, readJsonl } from "./session-store.js"

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
}

function overlapScore(a, b) {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  let score = 0
  for (const item of left) {
    if (right.has(item)) score += 1
  }
  return score
}

export async function loadRelevantKnowledge({ rootDir, prompt, cwd, limit = 3 }) {
  const filePath = path.join(rootDir, "knowledge", "executions.jsonl")
  const items = await readJsonl(filePath)
  return items
    .map((item) => ({
      ...item,
      score: overlapScore(prompt, [item.prompt, item.goal, item.reasoningSummary].filter(Boolean).join(" ")),
    }))
    .filter((item) => item.cwd === cwd && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export async function appendKnowledgeRecord({ rootDir, record }) {
  const filePath = path.join(rootDir, "knowledge", "executions.jsonl")
  await appendJsonl(filePath, record)
}
