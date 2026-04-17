import fs from "node:fs/promises"
import path from "node:path"

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

export function createRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-")
  return `${stamp}-${randomSuffix()}`
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, value, "utf8")
}

export async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8")
}

export async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
}

export async function createSessionStore({ cwd, artifactRoot, runId = createRunId(), now = new Date() }) {
  const rootDir = path.resolve(artifactRoot ?? process.env.CUSTCLI_SESSION_DIR ?? path.join(cwd, ".custcli"))
  const sessionDir = path.join(rootDir, "sessions", runId)
  const knowledgeDir = path.join(rootDir, "knowledge")

  await ensureDir(sessionDir)
  await ensureDir(knowledgeDir)

  return {
    cwd,
    rootDir,
    sessionDir,
    knowledgeDir,
    runId,
    createdAt: now.toISOString(),
    path(...parts) {
      return path.join(sessionDir, ...parts)
    },
    async writeJson(name, value) {
      const filePath = path.join(sessionDir, name)
      await writeJson(filePath, value)
      return filePath
    },
    async writeText(name, value) {
      const filePath = path.join(sessionDir, name)
      await writeText(filePath, value)
      return filePath
    },
  }
}
