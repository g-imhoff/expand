import { Console } from "effect"

export interface RenderOpts {
  readonly format: "json" | "text"
  readonly quiet: boolean
}

// stdout (success data only) and stderr (diagnostics + errors).
export const writeOut = (line: string) => Console.log(line)
export const writeErr = (line: string) => Console.error(line)

// Pure: choose the success line for the resolved opts.
export const successLine = (
  opts: RenderOpts,
  parts: { readonly envelope: object; readonly text: string; readonly quiet: string }
): string => (opts.quiet ? parts.quiet : opts.format === "json" ? JSON.stringify(parts.envelope) : parts.text)
