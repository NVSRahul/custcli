import { spawn } from "node:child_process"

export function parseCommandSpec({ env, jsonKey, binKey, fallback }) {
  const json = env[jsonKey]
  if (json) {
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch (error) {
      throw new Error(`${jsonKey} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`${jsonKey} must be a non-empty JSON array of strings`)
    }
    return parsed
  }

  const binary = env[binKey]
  if (binary) return [binary]
  return fallback
}

export function splitCommandSpec(commandSpec) {
  const [command, ...baseArgs] = commandSpec
  if (!command) throw new Error("Command spec must contain at least one element")
  return { command, baseArgs }
}

export async function runCommand({
  commandSpec,
  args = [],
  cwd,
  input,
  env = process.env,
  onStdout,
  onStderr,
  stdio = "pipe",
  timeoutMs,
}) {
  const { command, baseArgs } = splitCommandSpec(commandSpec)
  const child = spawn(command, [...baseArgs, ...args], {
    cwd,
    env,
    stdio,
  })

  let stdout = ""
  let stderr = ""
  let timedOut = false
  let timeoutHandle
  let forceKillHandle

  const clearKillTimers = () => {
    clearTimeout(timeoutHandle)
    clearTimeout(forceKillHandle)
  }

  const scheduleTimeout = () => {
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return
    clearKillTimers()
    timeoutHandle = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGTERM")
      } catch {
      }
      forceKillHandle = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
        }
      }, 1000)
      forceKillHandle.unref?.()
    }, timeoutMs)
    timeoutHandle.unref?.()
  }

  if (child.stdout) {
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      scheduleTimeout()
      onStdout?.(chunk)
    })
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      scheduleTimeout()
      onStderr?.(chunk)
    })
  }

  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code, signal) => {
      resolve({ code, signal })
    })
  })

  scheduleTimeout()

  if (child.stdin) {
    if (input !== undefined) {
      child.stdin.write(input)
    }
    child.stdin.end()
  }

  const { code, signal } = await exitPromise
  clearKillTimers()

  return {
    code: code ?? 0,
    signal,
    stdout,
    stderr,
    timedOut,
    ok: code === 0,
  }
}

export async function runInherited({ commandSpec, args = [], cwd, env = process.env }) {
  const { command, baseArgs } = splitCommandSpec(commandSpec)
  const child = spawn(command, [...baseArgs, ...args], {
    cwd,
    env,
    stdio: "inherit",
  })

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (exitCode) => resolve(exitCode ?? 0))
  })

  if (code !== 0) {
    throw new Error(`${command} exited with code ${code}`)
  }
}
