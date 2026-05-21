SHELL := /bin/bash
COMPOSE_DIR := examples/jaeger-otelcol

# Telemetry env shared by every run target.
OTEL_ENV := \
  OPENCODE_OTEL_ENABLED=1 \
  OPENCODE_OTEL_SINK=otlp-http \
  OPENCODE_OTEL_OTLP_ENDPOINT=http://localhost:4318 \
  OPENCODE_OTEL_DEBUG=1

# Adds prompt / tool arg / tool output capture.
OTEL_VERBOSE_ENV := $(OTEL_ENV) OPENCODE_OTEL_CAPTURE_CONTENT=1

.PHONY: help up down logs clean console \
        run-quiet run-warn run-info run-debug run-debug-verbose \
        typecheck

help:
	@echo "Test stack"
	@echo "  up                 start Jaeger + OTel Collector"
	@echo "  down               stop the stack"
	@echo "  logs               tail the collector's debug exporter (logs + metrics live here)"
	@echo ""
	@echo "Run opencode against the stack (opencode --log-level controls opencode's own verbosity)"
	@echo "  console            sanity check the plugin only — NDJSON to stdout, no Jaeger"
	@echo "  run-quiet          OTLP on, opencode logs hidden"
	@echo "  run-warn           OTLP on, opencode --print-logs --log-level=WARN"
	@echo "  run-info           OTLP on, opencode --print-logs --log-level=INFO"
	@echo "  run-debug          OTLP on, opencode --print-logs --log-level=DEBUG"
	@echo "  run-debug-verbose  run-debug + capture prompt and tool content into spans"
	@echo ""
	@echo "Misc"
	@echo "  typecheck          tsc --noEmit"
	@echo "  clean              remove local NDJSON sink output"

up:
	cd $(COMPOSE_DIR) && docker compose up -d

down:
	cd $(COMPOSE_DIR) && docker compose down

logs:
	cd $(COMPOSE_DIR) && docker compose logs -f otelcol

console:
	OPENCODE_OTEL_ENABLED=1 OPENCODE_OTEL_SINK=console OPENCODE_OTEL_DEBUG=1 opencode

run-quiet:
	$(OTEL_ENV) opencode

run-warn:
	$(OTEL_ENV) opencode --print-logs --log-level=WARN

run-info:
	$(OTEL_ENV) opencode --print-logs --log-level=INFO

run-debug:
	$(OTEL_ENV) opencode --print-logs --log-level=DEBUG

run-debug-verbose:
	$(OTEL_VERBOSE_ENV) opencode --print-logs --log-level=DEBUG

typecheck:
	bunx tsc --noEmit

clean:
	rm -f opencode-otel.ndjson
