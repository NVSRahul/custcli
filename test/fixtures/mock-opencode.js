#!/usr/bin/env node

let stdin = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  stdin += chunk
})
process.stdin.on("end", () => {
  const now = Date.now()
  process.stdout.write(
    `${JSON.stringify({
      type: "step_start",
      part: { type: "step-start", time: { start: now } },
    })}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({
      type: "text",
      part: {
        type: "text",
        text: `Mock worker executed. Prompt size=${stdin.trim().length}`,
        time: { end: Date.now() },
      },
    })}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({
      type: "session.status",
      sessionID: "mock-session",
      status: { type: "idle" },
    })}\n`,
  )
})
