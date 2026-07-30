import { Crypto, Effect } from "effect"

export const newId = Effect.fn("Ids.newId")(function*() {
  const cryptoService = yield* Crypto.Crypto
  return yield* cryptoService.randomUUIDv4
})
