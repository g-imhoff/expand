import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { EndpointFromJson, PROTOCOL_VERSION } from "@expand/contracts/endpoint"

describe("Endpoint", () => {
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
