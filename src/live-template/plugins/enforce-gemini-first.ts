import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ALLOWED_FIRST_TOOLS = new Set(["gemini_plan", "gemini_cli"])
const GEMINI_TOOLS = new Set(["gemini_plan", "gemini_review"])
const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const configDir = path.resolve(pluginDir, "..")
const manifestPath = path.join(configDir, "custcli-live.json")

let cachedWorkspaceRoot: string | null = null
let cachedPlannerMode: "free" | "strict" | null = null

async function liveManifest() {
  try {
    const raw = await fs.readFile(manifestPath, "utf8")
    const manifest = JSON.parse(raw)
    return manifest && typeof manifest === "object" ? manifest : {}
  } catch {
    return {}
  }
}

async function workspaceRoot() {
  if (cachedWorkspaceRoot) return cachedWorkspaceRoot

  const manifest = await liveManifest()
  if (typeof manifest.workspaceRoot === "string" && manifest.workspaceRoot.trim()) {
    cachedWorkspaceRoot = path.resolve(manifest.workspaceRoot)
    return cachedWorkspaceRoot
  }

  cachedWorkspaceRoot = path.resolve(process.cwd())
  return cachedWorkspaceRoot
}

async function plannerMode() {
  if (cachedPlannerMode) return cachedPlannerMode
  const manifest = await liveManifest()
  cachedPlannerMode = manifest.plannerMode === "strict" ? "strict" : "free"
  return cachedPlannerMode
}

function isWithinRoot(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function rewriteWorkspaceLine(line: string, cwd: string) {
  const workspaceRootMatch = line.match(/^(\s*Workspace root(?: folder)?:\s*)(.+)$/i)
  if (workspaceRootMatch) {
    const candidate = path.resolve(workspaceRootMatch[2].trim())
    if (path.parse(candidate).root === candidate || !isWithinRoot(cwd, candidate)) {
      return `${workspaceRootMatch[1]}${cwd}`
    }
  }

  const workingDirectoryMatch = line.match(/^(\s*Working directory:\s*)(.+)$/i)
  if (workingDirectoryMatch) {
    const candidate = path.resolve(workingDirectoryMatch[2].trim())
    if (!isWithinRoot(cwd, candidate)) {
      return `${workingDirectoryMatch[1]}${cwd}`
    }
  }

  return line
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function rewriteScopedPath(text: string, cwd: string) {
  let next = String(text || "")
    .split("\n")
    .map((line) => rewriteWorkspaceLine(line, cwd))
    .join("\n")

  for (const name of ["test", "tests", "src", "lib", "app", "packages"]) {
    const scoped = path.join(cwd, name)
    if (!(await pathExists(scoped))) continue
    const pattern = new RegExp(`(^|[\\s("'\\\`])\\/${name}(?=$|[\\/\\s)"'.,:;])`, "g")
    next = next.replace(pattern, (_match, prefix) => `${prefix}${scoped}`)
  }

  return next
}

async function sanitizeGeminiArgs(tool: string, args: Record<string, any>) {
  if (!GEMINI_TOOLS.has(tool) || !args || typeof args !== "object") return args

  const cwd = await workspaceRoot()

  if (typeof args.request === "string") {
    args.request = await rewriteScopedPath(args.request, cwd)
  }

  if (typeof args.workspace_context === "string") {
    args.workspace_context = await rewriteScopedPath(args.workspace_context, cwd)
  }

  if (Array.isArray(args.changed_files)) {
    args.changed_files = args.changed_files.map((item) => {
      if (typeof item !== "string") return item
      if (item.startsWith("/test")) return path.join(cwd, item.slice(1))
      if (item.startsWith("/tests")) return path.join(cwd, item.slice(1))
      if (item.startsWith("/src")) return path.join(cwd, item.slice(1))
      if (item.startsWith("/lib")) return path.join(cwd, item.slice(1))
      return item
    })
  }

  return args
}

export const EnforceGeminiFirstPlugin: Plugin = async () => {
  const sessionState = new Map<string, { requiresPlanner: boolean }>()

  return {
    "chat.message": async (input, output) => {
      const role = output.message?.role
      if (role && role !== "user") return

      const mode = await plannerMode()
      sessionState.set(input.sessionID, {
        requiresPlanner: mode === "strict",
      })
    },

    "tool.execute.before": async (input, output) => {
      if (GEMINI_TOOLS.has(input.tool)) {
        output.args = await sanitizeGeminiArgs(input.tool, output.args)
      }
      const mode = await plannerMode()
      if (mode !== "strict") return

      const current = sessionState.get(input.sessionID)
      if (!current?.requiresPlanner) return
      if (ALLOWED_FIRST_TOOLS.has(input.tool)) return

      throw new Error(
        'Planner mode is strict for this live session. Gemini must run first for this user turn. Call "gemini_plan" before using OpenCode tools. Use "gemini_cli" only if the user explicitly wants direct Gemini CLI behavior.',
      )
    },

    "tool.execute.after": async (input) => {
      if (!ALLOWED_FIRST_TOOLS.has(input.tool)) return

      const current = sessionState.get(input.sessionID)
      if (!current) return
      current.requiresPlanner = false
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const mode = await plannerMode()
      output.system.unshift(
        [
          mode === "strict" ? "STRICT RUNTIME RULE:" : "FREE PLANNER MODE:",
          mode === "strict"
            ? 'For each substantive user turn, your first tool call must be "gemini_plan".'
            : 'Choose "gemini_plan" when the request genuinely needs external planning, architecture help, repo-wide analysis, or Gemini-first review. You may answer tiny or straightforward turns directly without Gemini.',
          mode === "strict"
            ? 'If the user explicitly wants direct Gemini CLI behavior, "gemini_cli" is the only allowed alternative first tool.'
            : 'If the user explicitly wants direct Gemini CLI behavior, use "gemini_cli".',
          "Start from the user's requested outcome.",
          "Prefer the simplest solution that fully solves the request.",
          "Do not add unrequested abstractions, flexibility, or extra features.",
          "Change only what is needed. Do not refactor unrelated code.",
          "Treat Gemini as the primary planner, reviewer, and suggestion source for architecture, direction, and quality checks.",
          "OpenCode is the executor, verifier, improver, and user-facing synthesizer.",
          "Treat Gemini output as high-authority guidance, then check it against the repository and tool output before acting.",
          "Treat Gemini plan/review results as internal working material, not text to dump back into the chat.",
          "If Gemini is right, continue with it. If it is weak or contradicted by the workspace, correct course and re-plan or re-review.",
          "If Gemini appears wrong or hallucinates, do not ignore it silently. Pass the concrete contradiction back through gemini_plan or gemini_review when practical, then use the corrected result before answering the user.",
          "Use Gemini review before concluding substantial work.",
          "If the user explicitly asks for a detailed inline report, answer inline.",
          "Do not write a report file unless the user explicitly asked for a file.",
          "If a long answer is needed, send it in clean chunks or sections instead of switching to a file.",
          "Distill Gemini output to only what matters for the current action or answer. Do not paste large raw Gemini blocks into the conversation.",
          'If you truly need more Gemini detail, inspect the returned artifact directory with Read or Grep and prefer files like "plan.json" or "review.json" before touching larger raw outputs.',
          'Do not explicitly say you "learned" from Gemini. Show the improvement through better execution and a better final answer.',
          "Do not invent Gemini model overrides. Leave the Gemini tool `model` argument empty unless the user explicitly requested a Gemini model change in the current turn.",
          'Do not use invented Gemini CLI flags like "--verbose". Headless Gemini uses "-p" or "--prompt".',
          'Do not ask Gemini to inspect root-level paths like "/test"; use relative workspace paths such as "test/" or the full current workspace path instead.',
          'Do not copy raw OpenCode environment metadata into Gemini context when it says "Workspace root folder: /"; use the actual current workspace path instead.',
          mode === "strict"
            ? "Do not use read, glob, grep, bash, task, write, edit, patch, or other OpenCode tools before Gemini planning for that turn."
            : "Use normal OpenCode tools when Gemini planning is not needed, but call Gemini before substantial final review or when repo-wide planning becomes necessary.",
          mode === "strict"
            ? "After Gemini planning succeeds, continue with normal OpenCode execution and later use Gemini review when appropriate."
            : "After Gemini planning succeeds, continue with normal OpenCode execution and later use Gemini review when appropriate.",
        ].join(" "),
      )
    },
  }
}
