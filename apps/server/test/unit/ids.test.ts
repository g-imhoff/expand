import { it } from "@effect/vitest"
import { Crypto, Effect, PlatformError } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import { newId } from "@expand/server/application/ids"

describe("newId", () => {
  it.effect("is a lazy Effect that produces a deterministic uuid", () => {
    let reads = 0
    const crypto = Crypto.make({
      randomBytes: (size) => {
        reads += 1
        return Uint8Array.from({ length: size }, (_, index) => index)
      },
      digest: (_algorithm, data) => Effect.succeed(data)
    })
    const id = newId()

    expectTypeOf(id).toMatchTypeOf<Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto>>()
    expect(Effect.isEffect(id)).toBe(true)
    expect(reads).toBe(0)

    return Effect.provideService(id, Crypto.Crypto, crypto).pipe(
      Effect.map((value) => {
        expect(value).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f")
        expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        expect(reads).toBe(1)
      })
    )
  })

  it.effect("reads fresh random bytes on every invocation", () => {
    let reads = 0
    const crypto = Crypto.make({
      randomBytes: (size) => {
        const value = reads
        reads += 1
        return new Uint8Array(size).fill(value)
      },
      digest: (_algorithm, data) => Effect.succeed(data)
    })

    return Effect.gen(function*() {
      const first = yield* newId()
      const second = yield* newId()
      expect(first).toBe("00000000-0000-4000-8000-000000000000")
      expect(second).toBe("01010101-0101-4101-8101-010101010101")
      expect(reads).toBe(2)
    }).pipe(Effect.provideService(Crypto.Crypto, crypto))
  })
})
