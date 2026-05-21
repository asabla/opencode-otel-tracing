import { appendFile } from "node:fs/promises"
import type { OtelSink, SinkContext } from "../types"

export function createFileSink(ctx: SinkContext): OtelSink {
  const path = ctx.config.file.path
  return {
    name: "file",
    async emit(signal) {
      try {
        await appendFile(path, JSON.stringify(signal) + "\n", "utf8")
      } catch (err) {
        ctx.log("error", "file sink write failed", err)
      }
    },
  }
}
