import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const LIVE_AGENT_NAME = "custcli-live"
export const LIVE_CONFIG_VERSION = 14

function resolveArtifactRoot(cwd, artifactRoot) {
  return path.resolve(artifactRoot ?? process.env.CUSTCLI_SESSION_DIR ?? path.join(cwd, ".custcli"))
}

async function copyTemplateDirectory(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true })
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name === "node_modules") continue

    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      await copyTemplateDirectory(sourcePath, targetPath)
      continue
    }

    await fs.copyFile(sourcePath, targetPath)
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function prepareLiveConfig({
  cwd,
  artifactRoot,
  plannerModel,
  plannerMode = "free",
  plannerApprovalMode = "plan",
}) {
  const rootDir = resolveArtifactRoot(cwd, artifactRoot)
  const liveConfigDir = path.join(rootDir, "opencode-live")
  const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "live-template")

  await copyTemplateDirectory(templateDir, liveConfigDir)

  const settingsPath = path.join(liveConfigDir, "runtime", "settings.json")
  const manifestPath = path.join(liveConfigDir, "custcli-live.json")
  const tuiConfigPath = path.join(liveConfigDir, "tui.json")

  await writeJson(settingsPath, {
    liveConfigVersion: LIVE_CONFIG_VERSION,
    defaultPlannerModel: plannerModel ?? null,
    plannerMode,
    defaultApprovalMode: plannerApprovalMode,
    geminiTimeoutMs: 180000,
    geminiSandbox: true,
  })

  await writeJson(manifestPath, {
    liveConfigVersion: LIVE_CONFIG_VERSION,
    agentName: LIVE_AGENT_NAME,
    workspaceRoot: cwd,
    artifactRoot: rootDir,
    liveConfigDir,
    plannerModel: plannerModel ?? null,
    plannerMode,
    plannerApprovalMode,
  })

  await writeJson(tuiConfigPath, {
    plugin: [path.join(liveConfigDir, "plugins", "gemini-status.ts")],
  })

  return {
    rootDir,
    liveConfigDir,
    settingsPath,
    manifestPath,
    tuiConfigPath,
    agentName: LIVE_AGENT_NAME,
  }
}
