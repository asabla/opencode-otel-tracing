import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { Emitter } from "./emitter"
import { createConsoleSink } from "./sinks/console"
import { createCustomSink } from "./sinks/custom"
import { createFileSink } from "./sinks/file"
import { createOtlpHttpSink } from "./sinks/otlp-http"
import type { Attributes, OtelSink, SinkContext } from "./types"

const TRUNCATE_LIMIT = 8000

const truncate = (s: string, n = TRUNCATE_LIMIT): string =>
  s.length <= n ? s : s.slice(0, n) + `…[+${s.length - n} chars]`

const asJson = (v: unknown): string => {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

async function resolveSink(spec: string, ctx: SinkContext): Promise<OtelSink> {
  switch (spec) {
    case "console":
      return createConsoleSink(ctx)
    case "file":
      return createFileSink(ctx)
    case "otlp-http":
      return createOtlpHttpSink(ctx)
    default:
      return await createCustomSink(spec, ctx)
  }
}

export const OtelPlugin: Plugin = async () => {
  const config = loadConfig()

  if (!config.enabled) {
    return {}
  }

  // Best-effort console-based diagnostics. Keeps the plugin self-contained
  // and avoids depending on opencode's own logging surface.
  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: unknown,
  ) => {
    const line = extra === undefined ? `[opencode-otel] ${message}` : `[opencode-otel] ${message} ${asJson(extra)}`
    if (level === "error" || level === "warn") {
      process.stderr.write(line + "\n")
    } else if (process.env["OPENCODE_OTEL_DEBUG"]) {
      process.stderr.write(line + "\n")
    }
  }

  const sinkCtx: SinkContext = { config, log }

  let sink: OtelSink
  try {
    sink = await resolveSink(config.sink, sinkCtx)
    await sink.init?.(sinkCtx)
  } catch (err) {
    log("error", `failed to initialize sink "${config.sink}", disabling plugin`, err)
    return {}
  }

  const emitter = new Emitter(sink, config, (msg, err) => log("error", msg, err))

  const onShutdown = async () => {
    try {
      await emitter.shutdown()
    } catch (err) {
      log("error", "shutdown failed", err)
    }
  }
  process.once("beforeExit", onShutdown)
  process.once("SIGINT", onShutdown)
  process.once("SIGTERM", onShutdown)

  log("info", `started (sink=${sink.name}, service=${config.serviceName})`)

  return {
    event: async ({ event }) => {
      const e = event as { type: string; properties?: Record<string, unknown> }
      const props = (e.properties ?? {}) as Record<string, unknown>

      switch (e.type) {
        case "session.created": {
          const info = props["info"] as { id?: string; title?: string } | undefined
          if (info?.id) {
            const attrs: Attributes = { "gen_ai.operation.name": "invoke_agent" }
            if (info.title) attrs["session.title"] = info.title
            emitter.startSessionSpan(info.id, "session", attrs)
          }
          break
        }
        case "session.updated": {
          const info = props["info"] as { id?: string; title?: string } | undefined
          if (info?.id && info.title) {
            emitter.updateSessionAttrs(info.id, { "session.title": info.title })
          }
          break
        }
        case "session.error": {
          const sessionID = props["sessionID"] as string | undefined
          const err = props["error"] as { name?: string; message?: string } | undefined
          const message = err?.message ?? err?.name ?? "unknown error"
          emitter.recordSessionError(sessionID, message)
          emitter.emitLog({
            severity: "ERROR",
            body: `session error: ${message}`,
            sessionId: sessionID,
            attributes: { "error.type": err?.name ?? "unknown" },
          })
          break
        }
        case "session.idle": {
          const sessionID = props["sessionID"] as string | undefined
          if (sessionID) emitter.endSessionSpan(sessionID, "OK")
          break
        }
        case "session.compacted": {
          const sessionID = props["sessionID"] as string | undefined
          emitter.emitLog({
            severity: "INFO",
            body: "session compacted",
            sessionId: sessionID,
            attributes: { event: "session.compacted" },
          })
          break
        }
        case "session.deleted": {
          // If the session is deleted before going idle, close out the span.
          const info = props["info"] as { id?: string } | undefined
          if (info?.id) emitter.endSessionSpan(info.id, "UNSET", "deleted")
          break
        }
        case "message.updated": {
          const info = props["info"] as
            | {
                role?: string
                sessionID?: string
                modelID?: string
                providerID?: string
                tokens?: {
                  input?: number
                  output?: number
                  reasoning?: number
                  cache?: { read?: number; write?: number }
                }
                cost?: number
                time?: { completed?: number }
              }
            | undefined
          if (info?.role !== "assistant" || !info.sessionID) break
          if (!info.time?.completed) break // only emit on completion

          const labels: Attributes = {
            "session.id": info.sessionID,
            "gen_ai.system": info.providerID ?? "unknown",
            "gen_ai.request.model": info.modelID ?? "unknown",
          }

          const t = info.tokens
          if (t) {
            const tokens: Array<[string, number | undefined]> = [
              ["opencode.tokens.input", t.input],
              ["opencode.tokens.output", t.output],
              ["opencode.tokens.reasoning", t.reasoning],
              ["opencode.tokens.cache.read", t.cache?.read],
              ["opencode.tokens.cache.write", t.cache?.write],
            ]
            for (const [name, value] of tokens) {
              if (typeof value === "number") {
                emitter.emitMetric({
                  name,
                  type: "counter",
                  unit: "tokens",
                  value,
                  attributes: labels,
                })
              }
            }
          }

          if (typeof info.cost === "number") {
            emitter.emitMetric({
              name: "opencode.cost",
              type: "counter",
              unit: "USD",
              value: info.cost,
              attributes: labels,
            })
          }

          emitter.updateSessionAttrs(info.sessionID, {
            "gen_ai.request.model": info.modelID ?? null,
            "gen_ai.system": info.providerID ?? null,
          })

          // Close the LLM span we opened on chat.params, attaching usage and
          // cost as span attributes so traces are self-contained.
          const llmAttrs: Attributes = {
            "gen_ai.response.model": info.modelID ?? null,
            "gen_ai.usage.input_tokens": info.tokens?.input ?? null,
            "gen_ai.usage.output_tokens": info.tokens?.output ?? null,
            "gen_ai.usage.reasoning_tokens": info.tokens?.reasoning ?? null,
            "gen_ai.usage.cache.read_tokens": info.tokens?.cache?.read ?? null,
            "gen_ai.usage.cache.write_tokens": info.tokens?.cache?.write ?? null,
            "opencode.cost": info.cost ?? null,
          }
          const errInfo = (info as { error?: { name?: string; message?: string } }).error
          emitter.endLlmSpan(info.sessionID, llmAttrs, errInfo?.message ?? errInfo?.name)
          break
        }
        case "file.edited": {
          const file = props["file"] as string | undefined
          const ev = props["event"] as string | undefined
          emitter.emitLog({
            severity: "INFO",
            body: `file ${ev ?? "edited"}: ${file ?? "?"}`,
            attributes: {
              "opencode.file.path": file ?? "",
              "opencode.file.event": ev ?? "",
            },
          })
          break
        }
        case "command.executed": {
          const sessionID = props["sessionID"] as string | undefined
          const name = props["name"] as string | undefined
          emitter.emitLog({
            severity: "INFO",
            body: `command: ${name ?? "unknown"}`,
            sessionId: sessionID,
            attributes: { "opencode.command": name ?? "unknown" },
          })
          break
        }
      }
    },

    "chat.params": async (input, _output) => {
      emitter.startLlmSpan(input.sessionID, {
        "gen_ai.system": input.provider?.info?.id ?? input.model?.providerID ?? "unknown",
        "gen_ai.request.model": input.model?.id ?? "unknown",
        "opencode.agent": input.agent ?? null,
      })
    },

    "permission.ask": async (input, output) => {
      const i = input as {
        sessionID?: string
        type?: string
        pattern?: string
        title?: string
      }
      emitter.addSessionEvent(i.sessionID ?? "", "permission.ask", {
        "opencode.permission.type": i.type ?? "",
        "opencode.permission.pattern": i.pattern ?? "",
        "opencode.permission.decision": output.status,
      })
      emitter.emitLog({
        severity: "INFO",
        body: `permission ${output.status}: ${i.type ?? "?"} ${i.pattern ?? ""}`.trim(),
        sessionId: i.sessionID,
        attributes: {
          "opencode.permission.type": i.type ?? "",
          "opencode.permission.pattern": i.pattern ?? "",
          "opencode.permission.decision": output.status,
        },
      })
    },

    "experimental.session.compacting": async (input, output) => {
      emitter.emitChildSpan({
        sessionId: input.sessionID,
        name: "session.compacting",
        durationMs: 0,
        attributes: {
          "opencode.compaction.context.count": output.context?.length ?? 0,
        },
      })
    },

    "chat.message": async (input, output) => {
      if (!config.captureContent) return
      const text = output.parts
        .map((p) => ((p as { type?: string; text?: string }).type === "text" ? (p as { text?: string }).text ?? "" : ""))
        .filter(Boolean)
        .join("")
      if (!text) return
      emitter.emitLog({
        severity: "INFO",
        body: truncate(text),
        sessionId: input.sessionID,
        attributes: {
          "gen_ai.prompt.role": "user",
          "gen_ai.request.model": input.model?.modelID ?? null,
          "gen_ai.system": input.model?.providerID ?? null,
        },
      })
    },

    "tool.execute.before": async (input, output) => {
      const attrs: Attributes = {}
      if (config.captureContent) {
        attrs["gen_ai.tool.args"] = truncate(asJson(output.args))
      }
      emitter.startToolSpan(input.sessionID, input.callID, input.tool, attrs)
    },

    "tool.execute.after": async (input, output) => {
      const attrs: Attributes = {
        "gen_ai.tool.title": output.title,
      }
      if (config.captureContent) {
        attrs["gen_ai.tool.output"] = truncate(output.output)
      }
      emitter.endToolSpan(input.sessionID, input.callID, attrs)
    },
  }
}
