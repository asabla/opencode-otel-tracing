import type {
  Attributes,
  OtelSink,
  OtelSpan,
  SinkContext,
  SpanStatusCode,
} from "../types"

const SEVERITY_NUMBER: Record<string, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
}

const SCOPE = { name: "opencode-otel-tracing", version: "0.1.0" }

const anyValue = (v: unknown): Record<string, unknown> => {
  if (typeof v === "string") return { stringValue: v }
  if (typeof v === "boolean") return { boolValue: v }
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  }
  if (v === null || v === undefined) return { stringValue: "" }
  return { stringValue: JSON.stringify(v) }
}

const toAttrList = (attrs: Attributes): Array<Record<string, unknown>> =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: anyValue(value) }))

const statusCode = (code: SpanStatusCode): number =>
  code === "OK" ? 1 : code === "ERROR" ? 2 : 0

export function createOtlpHttpSink(ctx: SinkContext): OtelSink {
  const baseUrl = ctx.config.otlp.endpoint.replace(/\/+$/, "")
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...ctx.config.otlp.headers,
  }
  const resource = {
    attributes: toAttrList({
      "service.name": ctx.config.serviceName,
      ...ctx.config.resourceAttrs,
    }),
  }

  const buffers = {
    spans: [] as Array<Record<string, unknown>>,
    logs: [] as Array<Record<string, unknown>>,
    metrics: [] as Array<Record<string, unknown>>,
  }
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const FLUSH_INTERVAL_MS = 1000

  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_INTERVAL_MS)
  }

  async function send(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        ctx.log("error", `OTLP ${path} -> ${res.status}`, text)
      }
    } catch (err) {
      ctx.log("error", `OTLP ${path} failed`, err)
    }
  }

  async function flush(): Promise<void> {
    const spans = buffers.spans
    const logs = buffers.logs
    const metrics = buffers.metrics
    buffers.spans = []
    buffers.logs = []
    buffers.metrics = []

    const tasks: Promise<void>[] = []
    if (spans.length) {
      tasks.push(
        send("/v1/traces", {
          resourceSpans: [{ resource, scopeSpans: [{ scope: SCOPE, spans }] }],
        }),
      )
    }
    if (logs.length) {
      tasks.push(
        send("/v1/logs", {
          resourceLogs: [{ resource, scopeLogs: [{ scope: SCOPE, logRecords: logs }] }],
        }),
      )
    }
    if (metrics.length) {
      tasks.push(
        send("/v1/metrics", {
          resourceMetrics: [{ resource, scopeMetrics: [{ scope: SCOPE, metrics }] }],
        }),
      )
    }
    await Promise.all(tasks)
  }

  const spanToWire = (s: OtelSpan): Record<string, unknown> => ({
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: 1,
    startTimeUnixNano: String(s.startTimeNs),
    endTimeUnixNano: String(s.endTimeNs),
    attributes: toAttrList(s.attributes),
    status: {
      code: statusCode(s.status.code),
      ...(s.status.message ? { message: s.status.message } : {}),
    },
    events: s.events?.map((e) => ({
      timeUnixNano: String(e.timeNs),
      name: e.name,
      attributes: e.attributes ? toAttrList(e.attributes) : [],
    })),
  })

  return {
    name: "otlp-http",
    emit(signal) {
      if (signal.kind === "span") {
        buffers.spans.push(spanToWire(signal))
      } else if (signal.kind === "log") {
        buffers.logs.push({
          timeUnixNano: String(signal.timeNs),
          severityNumber: SEVERITY_NUMBER[signal.severity] ?? 9,
          severityText: signal.severity,
          body: { stringValue: signal.body },
          attributes: toAttrList(signal.attributes),
          ...(signal.traceId ? { traceId: signal.traceId } : {}),
          ...(signal.spanId ? { spanId: signal.spanId } : {}),
        })
      } else {
        // All metric flavors are emitted as gauge data points with a single
        // value. This is a deliberate simplification: it preserves the value
        // and labels, works with every OTLP collector, and avoids the
        // accumulation state that proper counters/histograms would require.
        buffers.metrics.push({
          name: signal.name,
          ...(signal.description ? { description: signal.description } : {}),
          ...(signal.unit ? { unit: signal.unit } : {}),
          gauge: {
            dataPoints: [
              {
                attributes: toAttrList(signal.attributes),
                timeUnixNano: String(signal.timeNs),
                asDouble: signal.value,
              },
            ],
          },
        })
      }
      scheduleFlush()
    },
    async flush() {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      await flush()
    },
    async shutdown() {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      await flush()
    },
  }
}
