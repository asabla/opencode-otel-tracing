export type AttrValue = string | number | boolean

export type Attributes = Record<string, AttrValue | null | undefined>

export interface OtelConfig {
  enabled: boolean
  sink: string
  serviceName: string
  resourceAttrs: Record<string, AttrValue>
  captureContent: boolean
  disable: { traces: boolean; logs: boolean; metrics: boolean }
  otlp: { endpoint: string; headers: Record<string, string> }
  file: { path: string }
}

export type Severity = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"

export type SpanStatusCode = "UNSET" | "OK" | "ERROR"

export interface SpanEvent {
  name: string
  timeNs: number
  attributes?: Attributes
}

export interface OtelSpan {
  kind: "span"
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeNs: number
  endTimeNs: number
  attributes: Attributes
  status: { code: SpanStatusCode; message?: string }
  events?: SpanEvent[]
}

export interface OtelLog {
  kind: "log"
  timeNs: number
  severity: Severity
  body: string
  attributes: Attributes
  traceId?: string
  spanId?: string
}

export interface OtelMetric {
  kind: "metric"
  timeNs: number
  name: string
  description?: string
  unit?: string
  type: "counter" | "gauge" | "histogram"
  value: number
  attributes: Attributes
}

export type OtelSignal = OtelSpan | OtelLog | OtelMetric

export interface SinkContext {
  config: OtelConfig
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: unknown,
  ) => void
}

export interface OtelSink {
  name: string
  init?(ctx: SinkContext): void | Promise<void>
  emit(signal: OtelSignal): void | Promise<void>
  flush?(): void | Promise<void>
  shutdown?(): void | Promise<void>
}

export type SinkFactory = (ctx: SinkContext) => OtelSink | Promise<OtelSink>
