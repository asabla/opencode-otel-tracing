# AGENTS.md

## Purpose

This repository contains a minimal OpenTelemetry plugin for `opencode`.

Core constraints:
- Plugin is off by default and becomes inert unless `OPENCODE_OTEL_ENABLED` is truthy.
- No runtime dependencies are bundled.
- Configuration is environment-variable only.
- Emission is best-effort: sink failures should not crash `opencode`.
- Signals are represented as small internal TypeScript types, then written to a pluggable sink.

When making changes, preserve those constraints unless the user explicitly asks for a broader redesign.

## Stack

- Language: TypeScript
- Module format: ESM (`"type": "module"`)
- Type checking: `tsc --noEmit`
- Package manager / toolchain: Bun is used in the repo (`bun.lock`, `bunx tsc`)
- Host integration: `@opencode-ai/plugin`

## Repository Layout

- `index.ts`: public exports
- `src/plugin.ts`: plugin entry point, event hook wiring, sink selection
- `src/emitter.ts`: in-memory span state and serialized signal dispatch
- `src/config.ts`: env var parsing and config resolution
- `src/types.ts`: shared config, signal, and sink interfaces
- `src/sinks/console.ts`: NDJSON to stdout
- `src/sinks/file.ts`: NDJSON append-only file sink
- `src/sinks/otlp-http.ts`: batched OTLP/HTTP exporter
- `src/sinks/custom.ts`: dynamic import for user-provided sink modules
- `README.md`: user-facing install, usage, config, and local testing docs
- `Makefile`: local dev/test shortcuts
- `examples/jaeger-otelcol/`: local collector + Jaeger stack

## Development Commands

- Install deps: `bun install`
- Typecheck: `make typecheck` or `bunx tsc --noEmit`
- Run console sink locally: `make console`
- Start collector stack: `make up`
- Tail collector output: `make logs`
- Run against collector: `make run-quiet`, `make run-warn`, `make run-info`, `make run-debug`, `make run-debug-verbose`
- Stop stack: `make down`

If you change behavior that affects docs or operator workflow, update `README.md` and any relevant `Makefile` examples in the same change.

## Architecture

### 1. Plugin entry

`src/plugin.ts` is the only integration point with `opencode`.

Responsibilities:
- load config
- abort early when disabled
- construct the sink
- create the `Emitter`
- register shutdown hooks
- translate `opencode` events and hooks into spans, logs, and metrics

Prefer keeping host-specific event mapping in `plugin.ts`. Do not move `opencode` protocol knowledge into sinks.

### 2. Emitter

`src/emitter.ts` is the core telemetry state machine.

Important behavior:
- Session spans are stored by `sessionId`.
- Tool spans are stored by `sessionId:callId`.
- LLM spans are stored by `sessionId`.
- `dispatch()` serializes sink emission through a single promise chain.
- Disable flags are enforced centrally in `dispatch()`.
- `shutdown()` flushes orphaned LLM/session spans before closing the sink.

Do not break the serialized emit guarantee unless the user asks for a concurrency redesign.

### 3. Sinks

Sinks receive already-shaped internal signals.

Current sink contracts:
- `console`: writes one JSON line per signal to stdout
- `file`: appends one JSON line per signal to a file
- `otlp-http`: buffers spans/logs/metrics and POSTs them to `/v1/traces`, `/v1/logs`, `/v1/metrics`
- `custom`: imports an absolute-path module exporting `default` or `createSink`

Keep sinks dumb. Cross-signal correlation, span lifecycle, and suppression logic belong in `Emitter` or `plugin.ts`, not in sink implementations.

## Event To Signal Mapping

This is the main logic future edits tend to break.

- `session.created`: starts the root `session` span
- `session.updated`: updates session attributes such as title
- `session.error`: records exception data on the session span and emits an error log
- `session.idle`: closes the session span with `OK`
- `session.deleted`: closes the session span if it never reached idle
- `session.compacted`: emits an informational log
- `chat.params`: starts an `llm chat` span
- `message.updated` for completed assistant messages: closes the matching LLM span and emits token/cost metrics
- `tool.execute.before`: starts a tool span
- `tool.execute.after`: closes a tool span and emits tool duration metric
- `permission.ask`: adds a session event and emits a log
- `experimental.session.compacting`: emits a child span
- `chat.message`: logs prompt content only when capture is enabled
- `file.edited`, `command.executed`: emit informational logs

If you add a new start event for a span, make sure you also add a reliable close path, including shutdown behavior if needed.

## Configuration Rules

All config comes from env vars via `src/config.ts`.

Current shape:
- booleans are parsed by `flag()` using `1/true/yes/on`
- comma-separated `k=v` parsing is handled by `parseKV()`
- resource attr values are coerced to `string | number | boolean`

If you add a new environment variable, update all of:
- `src/config.ts`
- `src/types.ts` if config shape changes
- `README.md` configuration table
- `AGENTS.md` if the new setting changes contributor behavior or architecture

## Data Model Notes

- Internal telemetry types are defined in `src/types.ts`.
- Attributes allow `null` and `undefined` during construction, but OTLP serialization filters them out.
- Metric `type` exists in the internal model, but `otlp-http` deliberately exports every metric as a gauge data point.

That last point is intentional, not an oversight. Do not "fix" it casually without updating docs and reasoning through accumulation semantics.

## Coding Conventions

- Prefer minimal changes.
- Prefer small helpers over large abstractions.
- Preserve zero-runtime-dependency design.
- Preserve best-effort error handling.
- Avoid adding heavyweight OpenTelemetry SDK packages unless explicitly requested.
- Keep comments sparse and only where behavior is non-obvious.
- Follow existing naming and file layout unless there is a strong reason to change it.

## Validation Expectations

Minimum validation for most code changes:
- run `make typecheck`

When changing OTLP export or sink behavior, also validate with the local stack when feasible:
- `make up`
- run one of the `make run-*` targets
- inspect `make logs`

When changing docs only, no code validation is required.

## Documentation Sync Checklist

Update `README.md` when you change:
- environment variables
- supported sinks
- emitted signals
- local testing workflow
- public custom sink API

Update examples or `Makefile` when you change:
- collector endpoint expectations
- recommended local commands
- verbose capture workflow

## Known Limitations

These are deliberate tradeoffs in the current design:
- no bundled OpenTelemetry SDK
- metrics are simplified to gauge-style OTLP points
- plugin diagnostics go straight to stderr instead of using an external logger
- spans/logs/metrics are buffered in-memory for the OTLP sink until flush

Treat these as design choices, not bugs, unless the user asks to change them.

## Safe Change Patterns

Good changes:
- adding a new env var with docs and type updates
- mapping a new `opencode` event to an internal signal
- adding attributes to existing spans/logs/metrics
- improving sink robustness without changing public behavior

Changes that need extra care:
- altering span lifecycle pairing
- changing internal type shapes used by custom sinks
- changing shutdown/flush semantics
- adding dependencies
- changing OTLP wire format

## Public API Surface

Consumers may import from `index.ts`:
- `OtelPlugin`
- `OtelConfig`
- `OtelSignal`
- `OtelSpan`
- `OtelLog`
- `OtelMetric`
- `OtelSink`
- `SinkContext`
- `SinkFactory`

Be careful when changing exported types. Custom sink authors may depend on them.
