import type { OtelSink, SinkContext } from "../types"

export function createConsoleSink(_ctx: SinkContext): OtelSink {
  return {
    name: "console",
    emit(signal) {
      try {
        process.stdout.write(JSON.stringify(signal) + "\n")
      } catch {
        // stdout failure is non-recoverable; drop.
      }
    },
  }
}
