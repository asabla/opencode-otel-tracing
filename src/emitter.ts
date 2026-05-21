import type {
  Attributes,
  OtelConfig,
  OtelMetric,
  OtelSignal,
  OtelSink,
  OtelSpan,
  Severity,
  SpanStatusCode,
} from "./types"

const nowNs = (): number => Date.now() * 1_000_000

const randomHex = (len: number): string => {
  const bytes = new Uint8Array(len / 2)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

const randomTraceId = (): string => randomHex(32)
const randomSpanId = (): string => randomHex(16)

export class Emitter {
  private pending: Promise<unknown> = Promise.resolve()
  private sessionSpans = new Map<string, OtelSpan>()
  private toolSpans = new Map<string, OtelSpan>()
  private llmSpans = new Map<string, OtelSpan>()

  constructor(
    private readonly sink: OtelSink,
    private readonly config: OtelConfig,
    private readonly logError: (msg: string, err: unknown) => void,
  ) {}

  private dispatch(signal: OtelSignal): void {
    if (signal.kind === "span" && this.config.disable.traces) return
    if (signal.kind === "log" && this.config.disable.logs) return
    if (signal.kind === "metric" && this.config.disable.metrics) return
    this.pending = this.pending.then(() =>
      Promise.resolve()
        .then(() => this.sink.emit(signal))
        .catch((err) => this.logError("sink emit failed", err)),
    )
  }

  startSessionSpan(sessionId: string, name: string, attributes: Attributes): void {
    if (this.sessionSpans.has(sessionId)) return
    this.sessionSpans.set(sessionId, {
      kind: "span",
      traceId: randomTraceId(),
      spanId: randomSpanId(),
      name,
      startTimeNs: nowNs(),
      endTimeNs: 0,
      attributes: { "session.id": sessionId, ...attributes },
      status: { code: "UNSET" },
    })
  }

  updateSessionAttrs(sessionId: string, attributes: Attributes): void {
    const span = this.sessionSpans.get(sessionId)
    if (!span) return
    Object.assign(span.attributes, attributes)
  }

  recordSessionError(sessionId: string | undefined, message: string): void {
    if (!sessionId) return
    const span = this.sessionSpans.get(sessionId)
    if (!span) return
    span.events ??= []
    span.events.push({
      name: "exception",
      timeNs: nowNs(),
      attributes: { "exception.message": message },
    })
    span.status = { code: "ERROR", message }
  }

  endSessionSpan(
    sessionId: string,
    status: SpanStatusCode = "OK",
    statusMessage?: string,
    extraAttrs?: Attributes,
  ): void {
    const span = this.sessionSpans.get(sessionId)
    if (!span) return
    span.endTimeNs = nowNs()
    if (span.status.code !== "ERROR") {
      span.status = { code: status, message: statusMessage }
    }
    if (extraAttrs) Object.assign(span.attributes, extraAttrs)
    this.sessionSpans.delete(sessionId)
    this.dispatch(span)
  }

  startToolSpan(
    sessionId: string,
    callId: string,
    toolName: string,
    attributes: Attributes,
  ): void {
    const parent = this.sessionSpans.get(sessionId)
    this.toolSpans.set(`${sessionId}:${callId}`, {
      kind: "span",
      traceId: parent?.traceId ?? randomTraceId(),
      spanId: randomSpanId(),
      parentSpanId: parent?.spanId,
      name: `tool ${toolName}`,
      startTimeNs: nowNs(),
      endTimeNs: 0,
      attributes: {
        "session.id": sessionId,
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": callId,
        ...attributes,
      },
      status: { code: "UNSET" },
    })
  }

  endToolSpan(
    sessionId: string,
    callId: string,
    attributes: Attributes,
    error?: string,
  ): void {
    const key = `${sessionId}:${callId}`
    const span = this.toolSpans.get(key)
    if (!span) return
    span.endTimeNs = nowNs()
    Object.assign(span.attributes, attributes)
    span.status = error ? { code: "ERROR", message: error } : { code: "OK" }
    this.toolSpans.delete(key)
    this.dispatch(span)

    const durationMs = (span.endTimeNs - span.startTimeNs) / 1_000_000
    this.emitMetric({
      name: "opencode.tool.duration",
      unit: "ms",
      type: "histogram",
      value: durationMs,
      attributes: {
        "gen_ai.tool.name": String(span.attributes["gen_ai.tool.name"] ?? "unknown"),
        "session.id": sessionId,
        error: Boolean(error),
      },
    })
  }

  startLlmSpan(sessionId: string, attributes: Attributes): void {
    // If a previous LLM span never closed (no matching message.updated),
    // flush it as orphaned rather than leak the slot.
    const stale = this.llmSpans.get(sessionId)
    if (stale) {
      stale.endTimeNs = nowNs()
      stale.status = { code: "UNSET", message: "superseded" }
      this.dispatch(stale)
      this.llmSpans.delete(sessionId)
    }
    const parent = this.sessionSpans.get(sessionId)
    this.llmSpans.set(sessionId, {
      kind: "span",
      traceId: parent?.traceId ?? randomTraceId(),
      spanId: randomSpanId(),
      parentSpanId: parent?.spanId,
      name: "llm chat",
      startTimeNs: nowNs(),
      endTimeNs: 0,
      attributes: {
        "session.id": sessionId,
        "gen_ai.operation.name": "chat",
        ...attributes,
      },
      status: { code: "UNSET" },
    })
  }

  endLlmSpan(sessionId: string, attributes: Attributes, error?: string): void {
    const span = this.llmSpans.get(sessionId)
    if (!span) return
    span.endTimeNs = nowNs()
    Object.assign(span.attributes, attributes)
    span.status = error ? { code: "ERROR", message: error } : { code: "OK" }
    this.llmSpans.delete(sessionId)
    this.dispatch(span)
  }

  addSessionEvent(sessionId: string, name: string, attributes?: Attributes): void {
    const span = this.sessionSpans.get(sessionId)
    if (!span) return
    span.events ??= []
    span.events.push({ name, timeNs: nowNs(), attributes })
  }

  emitChildSpan(input: {
    sessionId: string
    name: string
    durationMs: number
    attributes?: Attributes
    error?: string
  }): void {
    const parent = this.sessionSpans.get(input.sessionId)
    const endNs = nowNs()
    const startNs = endNs - Math.max(0, Math.floor(input.durationMs * 1_000_000))
    this.dispatch({
      kind: "span",
      traceId: parent?.traceId ?? randomTraceId(),
      spanId: randomSpanId(),
      parentSpanId: parent?.spanId,
      name: input.name,
      startTimeNs: startNs,
      endTimeNs: endNs,
      attributes: { "session.id": input.sessionId, ...(input.attributes ?? {}) },
      status: input.error ? { code: "ERROR", message: input.error } : { code: "OK" },
    })
  }

  emitLog(input: {
    severity: Severity
    body: string
    attributes?: Attributes
    sessionId?: string
  }): void {
    const span = input.sessionId ? this.sessionSpans.get(input.sessionId) : undefined
    this.dispatch({
      kind: "log",
      timeNs: nowNs(),
      severity: input.severity,
      body: input.body,
      attributes: input.attributes ?? {},
      traceId: span?.traceId,
      spanId: span?.spanId,
    })
  }

  emitMetric(metric: Omit<OtelMetric, "kind" | "timeNs">): void {
    this.dispatch({ kind: "metric", timeNs: nowNs(), ...metric })
  }

  async flush(): Promise<void> {
    await this.pending
    await this.sink.flush?.()
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, span] of [...this.llmSpans]) {
      span.endTimeNs = nowNs()
      span.status = { code: "UNSET", message: "shutdown" }
      this.dispatch(span)
      this.llmSpans.delete(sessionId)
    }
    for (const sessionId of [...this.sessionSpans.keys()]) {
      this.endSessionSpan(sessionId, "UNSET", "shutdown")
    }
    await this.flush()
    await this.sink.shutdown?.()
  }
}
