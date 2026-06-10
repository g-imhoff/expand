import { afterEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { endpointFilePath, EndpointFromJson, PROTOCOL_VERSION, yodeaHomeDir } from "@yodea/contracts/endpoint"

const ORIGINAL = process.env.YODEA_ENDPOINT_FILE
const ORIGINAL_HOME = process.env.YODEA_HOME

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.YODEA_ENDPOINT_FILE
  else process.env.YODEA_ENDPOINT_FILE = ORIGINAL
  if (ORIGINAL_HOME === undefined) delete process.env.YODEA_HOME
  else process.env.YODEA_HOME = ORIGINAL_HOME
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

  it("yodeaHomeDir respects YODEA_HOME when set and falls back to ~/.yodea when unset", () => {
    process.env.YODEA_HOME = "/tmp/yodea-test-home"
    expect(yodeaHomeDir()).toBe("/tmp/yodea-test-home")
    delete process.env.YODEA_HOME
    expect(yodeaHomeDir()).toBe(join(homedir(), ".yodea"))
  })
})
