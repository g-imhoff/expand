import { Console } from "effect"

export interface RenderOpts {
  readonly format: "json" | "text"
  readonly quiet: boolean
}

export const writeOut = (line: string) => Console.log(line)
export const writeErr = (line: string) => Console.error(line)

export const successLine = (
  opts: RenderOpts,
  parts: { readonly envelope: object; readonly text: string; readonly quiet: string }
): string => (opts.quiet ? parts.quiet : opts.format === "json" ? JSON.stringify(parts.envelope) : parts.text)
