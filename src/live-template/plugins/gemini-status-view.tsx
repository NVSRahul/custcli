import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildGeminiSidebarState, pickGeminiStatus, safeSegment } from "./gemini-status-data.js"

const id = "custcli:gemini-status"
const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
const configDir = path.resolve(runtimeDir, "..")
const manifestPath = path.join(configDir, "custcli-live.json")
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

let cachedManifest: { artifactRoot?: string; workspaceRoot?: string } | null = null
async function loadManifest() {
  if (cachedManifest) return cachedManifest

  try {
    const raw = await fs.readFile(manifestPath, "utf8")
    cachedManifest = JSON.parse(raw)
  } catch {
    cachedManifest = {}
  }

  return cachedManifest
}

async function readGeminiStatus(sessionID: string) {
  const manifest = await loadManifest()
  const artifactRoot = manifest.artifactRoot ? path.resolve(manifest.artifactRoot) : path.resolve(configDir, "..")
  const workspaceRoot = manifest.workspaceRoot ? path.resolve(manifest.workspaceRoot) : undefined
  const statusDir = path.join(artifactRoot, "live", "status")

  try {
    const entries = await fs.readdir(statusDir)
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const filePath = path.join(statusDir, entry)
          try {
            return JSON.parse(await fs.readFile(filePath, "utf8"))
          } catch {
            return null
          }
        }),
    )
    return pickGeminiStatus({
      sessionID: safeSegment(sessionID),
      workspaceRoot,
      entries: records,
    })
  } catch {
    return {
      record: null,
      source: "none",
    }
  }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [now, setNow] = createSignal(Date.now())
  const [statusFile, setStatusFile] = createSignal<any>({ record: null, source: "none" })
  const [frameIndex, setFrameIndex] = createSignal(0)

  const refresh = async () => {
    setNow(Date.now())
    setStatusFile(await readGeminiStatus(props.session_id))
  }

  void refresh()
  const timer = setInterval(() => {
    void refresh()
  }, 1000)
  const animationTimer = setInterval(() => {
    setFrameIndex((value) => (value + 1) % spinnerFrames.length)
  }, 80)
  onCleanup(() => {
    clearInterval(timer)
    clearInterval(animationTimer)
  })

  const theme = () => props.api.theme.current
  const state = createMemo(() => {
    const gemini = statusFile()
    return buildGeminiSidebarState({
      record: gemini?.record ?? null,
      source: gemini?.source ?? "none",
      now: now(),
    })
  })

  const color = createMemo(() => {
    const value = state()
    if (value.status === "error") return theme().error
    if (value.status === "completed") return theme().success
    if (value.status === "idle") return theme().textMuted
    return theme().warning
  })

  return (
    <box gap={1}>
      <box flexDirection="row" gap={1} justifyContent="space-between">
        <text fg={theme().text}>
          <b>Gemini Live</b>
        </text>
        <Show
          when={state().status === "running"}
          fallback={<text fg={color()}>{state().status === "completed" ? "done" : state().status}</text>}
        >
          <Show
            when={props.api.kv.get("animations_enabled", true)}
            fallback={
              <box flexDirection="row" gap={1}>
                <text fg={color()}>⋯</text>
                <text fg={color()}>running</text>
              </box>
            }
          >
            <box flexDirection="row" gap={1}>
              <text fg={color()}>{spinnerFrames[frameIndex()]}</text>
              <text fg={color()}>running</text>
            </box>
          </Show>
        </Show>
      </box>
      <text fg={theme().text}>
        {state().label}
        <Show when={state().duration}>
          <span style={{ fg: theme().textMuted }}> · {state().duration}</span>
        </Show>
      </text>
      <Show when={state().model}>
        <text fg={theme().textMuted}>model: {state().model}</text>
      </Show>
      <Show when={state().summary}>
        <text fg={theme().textMuted}>{state().summary}</text>
      </Show>
      <Show when={state().detail}>
        <text fg={theme().textMuted}>{state().detail}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
