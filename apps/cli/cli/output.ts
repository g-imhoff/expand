import { Console, Effect, Schema } from "effect"

export interface RenderOpts {
  readonly format: "json" | "text"
  readonly quiet: boolean
}

export const writeOut = Effect.fn("Cli.writeOut")((line: string) => Console.log(line))
export const writeErr = Effect.fn("Cli.writeErr")((line: string) => Console.error(line))

export const successLine = (
  opts: RenderOpts,
  parts: { readonly envelope: object; readonly text: string; readonly quiet: string }
): string => (opts.quiet ? parts.quiet : opts.format === "json" ? encodeUnknown(parts.envelope) : parts.text)

const encodeUnknown = Schema.encodeSync(Schema.UnknownFromJsonString)
