import path from "node:path"
import type { OtelSink, SinkContext, SinkFactory } from "../types"

export async function createCustomSink(
  specPath: string,
  ctx: SinkContext,
): Promise<OtelSink> {
  if (!path.isAbsolute(specPath)) {
    throw new Error(
      `custom sink path must be absolute (got: ${specPath}). ` +
        `Set OPENCODE_OTEL_SINK to an absolute filesystem path.`,
    )
  }
  const mod = (await import(specPath)) as {
    default?: SinkFactory
    createSink?: SinkFactory
  }
  const factory = mod.default ?? mod.createSink
  if (typeof factory !== "function") {
    throw new Error(
      `custom sink at ${specPath} must export default (or createSink) ` +
        `as a function (ctx: SinkContext) => OtelSink`,
    )
  }
  return await factory(ctx)
}
