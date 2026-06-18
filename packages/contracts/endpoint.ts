import { Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROTOCOL_VERSION = 2

export class Endpoint extends Schema.Opaque<Endpoint>()(
  Schema.Struct({
    url: Schema.String,
    token: Schema.String,
    pid: Schema.Number,
    protocolVersion: Schema.Number
  })
) { }

export const EndpointFromJson = Schema.fromJsonString(Endpoint)

// CRITICAL Env variable should be restricted to only testing purpose
export const yodeaHomeDir = (): string => process.env.YODEA_HOME ?? join(homedir(), ".yodea")

// CRITICAL : Env variable should be restricted to only testing purpose
export const endpointFilePath = (): string =>
  process.env.YODEA_ENDPOINT_FILE ?? join(yodeaHomeDir(), "server.json")
