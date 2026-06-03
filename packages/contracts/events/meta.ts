import { Schema } from "effect"

export const DomainEventMeta = {
  occurredAt: Schema.String
}

export const withMeta = <const M extends Schema.Struct.Fields, const C extends Record<string, Schema.Struct.Fields>>(
  meta: M,
  cases: C
): { [K in keyof C]: M & C[K] } => {
  const out = {} as { [K in keyof C]: M & C[K] }
  for (const k in cases) {
    out[k] = { ...meta, ...cases[k] } as M & C[typeof k]
  }
  return out
}
