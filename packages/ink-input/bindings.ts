// packages/ink-input/bindings.ts
// Pure module — must never import "ink". Bindings are data: the same table
// drives the router's dispatch AND the hint bar, so visible help always
// equals fireable keys.
import type { KeyName } from "@yodea/ink-input/key-name"

export type Binding<A> = {
  readonly keys: readonly [KeyName, ...Array<KeyName>]
  readonly label: string
  readonly action: A
}

/** First match wins, then stops — a key can never resolve to two actions. */
export const resolveBinding = <A>(
  table: ReadonlyArray<Binding<A>>, keyName: KeyName
): A | null => {
  for (const binding of table) {
    if (binding.keys.includes(keyName)) return binding.action
  }
  return null
}
