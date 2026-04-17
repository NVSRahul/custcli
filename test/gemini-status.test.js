import test from "node:test"
import assert from "node:assert/strict"
import { buildGeminiSidebarState, pickGeminiStatus } from "../src/live-template/plugins/gemini-status-data.js"

test("pickGeminiStatus prefers the exact session match", () => {
  const result = pickGeminiStatus({
    sessionID: "ses_current",
    workspaceRoot: "/workspace",
    entries: [
      { sessionID: "ses_other", workspaceRoot: "/workspace", updatedAt: 20, phase: "running" },
      { sessionID: "ses_current", workspaceRoot: "/workspace", updatedAt: 10, phase: "completed" },
    ],
  })

  assert.equal(result.source, "session")
  assert.equal(result.record.sessionID, "ses_current")
})

test("pickGeminiStatus falls back to the latest workspace status", () => {
  const result = pickGeminiStatus({
    sessionID: "missing",
    workspaceRoot: "/workspace",
    entries: [
      { sessionID: "ses_old", workspaceRoot: "/workspace", updatedAt: 10, phase: "completed" },
      { sessionID: "ses_new", workspaceRoot: "/workspace", updatedAt: 25, phase: "running" },
      { sessionID: "ses_other", workspaceRoot: "/other", updatedAt: 30, phase: "running" },
    ],
  })

  assert.equal(result.source, "workspace")
  assert.equal(result.record.sessionID, "ses_new")
})

test("buildGeminiSidebarState returns an idle state when no Gemini record exists", () => {
  const state = buildGeminiSidebarState({
    record: null,
    source: "none",
    now: 1000,
  })

  assert.equal(state.status, "idle")
  assert.match(state.summary, /No Gemini activity yet/i)
})

test("buildGeminiSidebarState preserves review status and workspace fallback detail", () => {
  const state = buildGeminiSidebarState({
    record: {
      kind: "review",
      phase: "completed",
      summary: "Reviewed test files successfully.",
      workspaceRoot: "/workspace",
      startedAt: 1000,
      updatedAt: 5100,
    },
    source: "workspace",
    now: 7000,
  })

  assert.equal(state.label, "Reviewing")
  assert.equal(state.status, "completed")
  assert.equal(state.duration, "4s")
  assert.match(state.detail, /latest workspace Gemini activity/i)
})
