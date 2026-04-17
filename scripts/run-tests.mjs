import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"

const rootDir = process.cwd()
const testDir = path.join(rootDir, "test")
const entries = await fs.readdir(testDir, { withFileTypes: true })
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join("test", entry.name))
  .sort()

if (testFiles.length === 0) {
  process.stderr.write("No test files found in test/.\n")
  process.exit(1)
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: rootDir,
  stdio: "inherit",
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
