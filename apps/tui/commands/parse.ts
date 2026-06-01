export type ParsedInput =
  | { readonly kind: "command"; readonly name: string; readonly args: ReadonlyArray<string> }
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "empty" }

export const parseInput = (raw: string): ParsedInput => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: "empty" }
  if (trimmed.startsWith("/")) {
    const parts = trimmed.slice(1).split(/\s+/).filter((p) => p.length > 0)
    const name = parts[0] ?? ""
    return { kind: "command", name, args: parts.slice(1) }
  }
  return { kind: "message", text: trimmed }
}
