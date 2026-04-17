const args = process.argv.slice(2)

if (args[0] === "session" && args[1] === "list" && args.includes("--format") && args.includes("json")) {
  const sessions = [
    {
      id: "ses_alpha",
      title: "Alpha session",
      updated: "2026-04-16T18:05:00.000Z",
      created: "2026-04-16T18:00:00.000Z",
      projectId: "project-alpha",
      directory: process.cwd(),
    },
  ]

  process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`)
  process.exit(0)
}

process.stderr.write(`Unexpected mock-opencode-session-list invocation: ${args.join(" ")}\n`)
process.exit(1)
