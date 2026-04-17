import {
  getGeminiCommandSpec,
  runGeminiPlanner,
  runGeminiReviewer,
} from "./gemini-adapter.js"

function normalizeProvider(value) {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized || "gemini"
}

export function getReasoningProvider(env = process.env) {
  return normalizeProvider(env.CUSTCLI_REASONING_PROVIDER)
}

export function getReasoningAdapter(env = process.env) {
  const provider = getReasoningProvider(env)

  if (provider === "gemini") {
    const commandSpec = getGeminiCommandSpec(env)
    return {
      provider,
      async runPlanner(options) {
        return runGeminiPlanner({
          ...options,
          commandSpec,
        })
      },
      async runReviewer(options) {
        return runGeminiReviewer({
          ...options,
          commandSpec,
        })
      },
    }
  }

  throw new Error(`Unsupported reasoning provider "${provider}".`)
}
