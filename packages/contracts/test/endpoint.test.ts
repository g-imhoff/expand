import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"

describe("Endpoint", () => {
  it("PROTOCOL_VERSION is 2", () => {
    expect(PROTOCOL_VERSION).toBe(2)
  })

  it.effect("roundtrips through JSON text", () =>
    Effect.gen(function*() {
      const endpoint = {
        url: "ws://127.0.0.1:51789/rpc",
        token: "abc",
        pid: 4242,
        protocolVersion: PROTOCOL_VERSION
      }
      const json = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
      expect(yield* Schema.decodeUnknownEffect(EndpointFromJson)(json)).toEqual(endpoint)
    }))
})
