import type { AttrValue, OtelConfig } from "./types"

const env = (k: string): string => (process.env[k] ?? "").trim()

const flag = (k: string): boolean => {
  const v = env(k).toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const parseKV = (s: string): Record<string, string> => {
  if (!s) return {}
  const out: Record<string, string> = {}
  for (const pair of s.split(",")) {
    const idx = pair.indexOf("=")
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

const coerceAttrValue = (s: string): AttrValue => {
  if (s === "true") return true
  if (s === "false") return false
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s)
  return s
}

export function loadConfig(): OtelConfig {
  const resourceAttrs: Record<string, AttrValue> = {}
  for (const [k, v] of Object.entries(parseKV(env("OPENCODE_OTEL_RESOURCE_ATTRS")))) {
    resourceAttrs[k] = coerceAttrValue(v)
  }

  return {
    enabled: flag("OPENCODE_OTEL_ENABLED"),
    sink: env("OPENCODE_OTEL_SINK") || "console",
    serviceName: env("OPENCODE_OTEL_SERVICE_NAME") || "opencode",
    resourceAttrs,
    captureContent: flag("OPENCODE_OTEL_CAPTURE_CONTENT"),
    disable: {
      traces: flag("OPENCODE_OTEL_DISABLE_TRACES"),
      logs: flag("OPENCODE_OTEL_DISABLE_LOGS"),
      metrics: flag("OPENCODE_OTEL_DISABLE_METRICS"),
    },
    otlp: {
      endpoint: env("OPENCODE_OTEL_OTLP_ENDPOINT") || "http://localhost:4318",
      headers: parseKV(env("OPENCODE_OTEL_OTLP_HEADERS")),
    },
    file: {
      path: env("OPENCODE_OTEL_FILE_PATH") || "./opencode-otel.ndjson",
    },
  }
}
