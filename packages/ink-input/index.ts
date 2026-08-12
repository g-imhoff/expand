import { Box, Text, useInput } from "ink"
import * as React from "react"
export type KeyEvent = { readonly key: string; readonly input: string; readonly ctrl: boolean; readonly meta: boolean; readonly shift: boolean }
export type Bindings<A> = { readonly resolve: (event: KeyEvent) => A | null; readonly hints: () => ReadonlyArray<{ readonly key: string; readonly label: string }> }
export { defineBindings, useGlobalKeyRouter, HintBar }
type BindingEntry<A> = { readonly keys: readonly string[]; readonly label: string; readonly action: A }
const specialKeys = new Set(["up", "down", "left", "right", "return", "escape", "tab", "backspace", "delete", "pageup", "pagedown"])
const modifierOrder = ["ctrl", "meta", "shift"] as const
const parseKey = (value: string) => {
  if (typeof value !== "string" || value.length === 0) throw new Error("Binding keys must be nonempty")
  const parts = value.split("+"); const base = parts.pop()
  if (!base || (base.trim() === "") || ([...base].length !== 1 && !specialKeys.has(base))) throw new Error(`Unbindable key: ${value}`)
  const seen = new Set<string>()
  for (const modifier of parts) { if (!(modifierOrder as readonly string[]).includes(modifier) || seen.has(modifier)) throw new Error(`Malformed key chord: ${value}`); seen.add(modifier) }
  const prefix = modifierOrder.filter((modifier) => seen.has(modifier))
  return { key: base, ctrl: seen.has("ctrl"), meta: seen.has("meta"), shift: seen.has("shift"), canonical: [...prefix, base].join("+") }
}
const defineBindings = <A>(entries: ReadonlyArray<BindingEntry<A>>): Bindings<A> => {
  const seen = new Set<string>()
  const owned = entries.map((entry) => {
    if (!entry || !Array.isArray(entry.keys) || entry.keys.length === 0) throw new Error("Binding entries require keys")
    if (typeof entry.label !== "string" || entry.label.trim() === "") throw new Error("Binding labels must be nonblank")
    const parsed = entry.keys.map(parseKey); const keys = parsed.map(({ canonical }) => canonical)
    for (const key of keys) { if (seen.has(key)) throw new Error(`Duplicate binding key: ${key}`); seen.add(key) }
    return Object.freeze({ keys: Object.freeze(keys), parsed: Object.freeze(parsed), label: entry.label, action: entry.action })
  }); Object.freeze(owned)
  const hints = Object.freeze(owned.flatMap((entry) => entry.keys.map((key) => Object.freeze({ key, label: entry.label }))))
  return Object.freeze({ resolve: (event: KeyEvent) => { for (const entry of owned) if (entry.parsed.some((key) => key.key === event.key && key.ctrl === event.ctrl && key.meta === event.meta && key.shift === event.shift)) return entry.action; return null }, hints: () => hints })
}
const normalize = (input: string, key: Record<string, boolean>): KeyEvent => {
  const names: Array<[string, string]> = [["upArrow", "up"], ["downArrow", "down"], ["leftArrow", "left"], ["rightArrow", "right"], ["return", "return"], ["escape", "escape"], ["tab", "tab"], ["backspace", "backspace"], ["delete", "delete"], ["pageUp", "pageup"], ["pageDown", "pagedown"]]
  const special = names.find(([flag]) => key[flag])?.[1]
  return Object.freeze({ key: special ?? input, input: special ? "" : input, ctrl: Boolean(key.ctrl), meta: Boolean(key.meta), shift: Boolean(key.shift) })
}
const useGlobalKeyRouter = (onKey: (event: KeyEvent) => void): void => { useInput((input, key) => onKey(normalize(input, key as unknown as Record<string, boolean>))) }
const HintBar = <A,>({ bindings }: { bindings: Bindings<A> }) => React.createElement(Box, null, React.createElement(Text, { dimColor: true }, bindings.hints().map((hint) => `${hint.key} ${hint.label}`).join(" · ")))
