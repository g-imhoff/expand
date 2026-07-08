import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { EndpointFromJson, PROTOCOL_VERSION } from "@expand/contracts/endpoint"

describe("Endpoint", () => {
  it("roundtrips through JSON text", () => {
    const e = { url: "ws://127.0.0.1:51789/rpc", token: "abc", pid: 4242, protocolVersion: PROTOCOL_VERSION }
    const json = Schema.encodeSync(EndpointFromJson)(e)
    expect(Schema.decodeUnknownSync(EndpointFromJson)(json)).toEqual(e)
  })
})
