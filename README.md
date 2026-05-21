# opencode-otel-tracing

An OpenTelemetry plugin for [opencode](https://github.com/anomalyco/opencode).

- Disabled until `OPENCODE_OTEL_ENABLED=1`.
- No runtime dependencies.
- Sinks: `console`, `file`, `otlp-http`, or a custom module you provide.

## Install

```sh
git clone https://github.com/<you>/opencode-otel-tracing \
  ~/.config/opencode/plugins/opencode-otel-tracing
```

opencode loads it on startup. No `opencode.json` changes required.

## Usage

Print every signal as NDJSON to stdout:

```sh
OPENCODE_OTEL_ENABLED=1 OPENCODE_OTEL_SINK=console opencode
```

Send to a local OTLP/HTTP collector:

```sh
OPENCODE_OTEL_ENABLED=1 \
OPENCODE_OTEL_SINK=otlp-http \
OPENCODE_OTEL_OTLP_ENDPOINT=http://localhost:4318 \
opencode
```

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_OTEL_ENABLED` | `0` | Master toggle. The plugin is inert unless set to `1`/`true`/`yes`/`on`. |
| `OPENCODE_OTEL_SINK` | `console` | `console`, `file`, `otlp-http`, or an absolute path to a custom sink module. |
| `OPENCODE_OTEL_SERVICE_NAME` | `opencode` | `service.name` resource attribute. |
| `OPENCODE_OTEL_RESOURCE_ATTRS` | — | Comma-separated `k=v` pairs added to the resource. Example: `deployment.environment=dev,host=laptop`. |
| `OPENCODE_OTEL_CAPTURE_CONTENT` | `0` | Capture user prompts, tool args, and tool output. Off by default. |
| `OPENCODE_OTEL_DISABLE_TRACES` | `0` | Suppress span emission. |
| `OPENCODE_OTEL_DISABLE_LOGS` | `0` | Suppress log emission. |
| `OPENCODE_OTEL_DISABLE_METRICS` | `0` | Suppress metric emission. |
| `OPENCODE_OTEL_OTLP_ENDPOINT` | `http://localhost:4318` | Base URL for `otlp-http`. `/v1/traces`, `/v1/logs`, `/v1/metrics` are appended. |
| `OPENCODE_OTEL_OTLP_HEADERS` | — | Comma-separated `k=v` headers for `otlp-http`. |
| `OPENCODE_OTEL_FILE_PATH` | `./opencode-otel.ndjson` | Output path for the `file` sink. |
| `OPENCODE_OTEL_DEBUG` | — | Print the plugin's own diagnostics to stderr. |

## Signals

**Traces**
- `session` span per opencode session. Started at `session.created`, closed at `session.idle` or on error.
- `tool <name>` span per tool execution, parented to the session span.

**Metrics** (emitted as OTLP gauge data points)
- `opencode.tool.duration` (ms)
- `opencode.tokens.input` / `output` / `reasoning` / `cache.read` / `cache.write`
- `opencode.cost` (USD)

**Logs**
- `session.error`, `session.compacted`, `command.executed`.
- User prompts and tool args/output when `OPENCODE_OTEL_CAPTURE_CONTENT=1`.

## Custom sinks

Point `OPENCODE_OTEL_SINK` at an absolute path to a `.js` or `.ts` module:

```sh
OPENCODE_OTEL_SINK=/Users/me/code/my-otel-sink.ts
```

The module must `export default` (or `export const createSink`) a factory:

```ts
import type { OtelSink, SinkContext, OtelSignal } from "opencode-otel-tracing"

export default function createSink(ctx: SinkContext): OtelSink {
  return {
    name: "my-sink",
    async init() {},
    emit(signal: OtelSignal) {},
    async flush() {},
    async shutdown() {},
  }
}
```

`ctx.config` exposes the resolved env-var configuration. Read your own
namespaced env vars directly via `process.env`.

Guarantees:
- `emit` is called serially per sink instance.
- Rejected promises from `emit` are caught and will not crash opencode.
- `flush()` is awaited before `shutdown()` on process exit.

See `src/types.ts` for the full `OtelSignal` discriminated union.

## Limitations

- Metrics are emitted as gauge data points. Counters and histograms are not
  modeled with proper accumulation or bucket boundaries.
- No `@opentelemetry/*` packages are bundled. For a full SDK
  (BatchSpanProcessor, gRPC export, real histograms), wrap it in a custom
  sink.
- Attribute names borrow from the OpenInference / GenAI conventions where
  applicable but are not an exhaustive implementation of them.

## License

MIT
