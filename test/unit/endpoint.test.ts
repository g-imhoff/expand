import { afterEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { endpointFilePath, EndpointFromJson, PROTOCOL_VERSION } from "@yodea/contracts/endpoint"

const ORIGINAL = process.env.YODEA_ENDPOINT_FILE

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.YODEA_ENDPOINT_FILE
  else process.env.YODEA_ENDPOINT_FILE = ORIGINAL
})

describe("Endpoint", () => {
  it("roundtrips through JSON text", () => {
    const e = { url: "ws://127.0.0.1:51789/rpc", token: "abc", pid: 4242, protocolVersion: PROTOCOL_VERSION }
    const json = Schema.encodeSync(EndpointFromJson)(e)
    expect(Schema.decodeUnknownSync(EndpointFromJson)(json)).toEqual(e)
  })

  it("honors YODEA_ENDPOINT_FILE override", () => {
    process.env.YODEA_ENDPOINT_FILE = "/tmp/yodea-test/server.json"
    expect(endpointFilePath()).toBe("/tmp/yodea-test/server.json")
  })
})
