import fs from "node:fs/promises"

const captureFile = process.env.CUSTCLI_CAPTURE_FILE
if (!captureFile) {
  throw new Error("CUSTCLI_CAPTURE_FILE is required for mock-opencode-live.js")
}

await fs.writeFile(
  captureFile,
  `${JSON.stringify(
    {
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: {
        OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
        CUSTCLI_LIVE: process.env.CUSTCLI_LIVE,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
)
