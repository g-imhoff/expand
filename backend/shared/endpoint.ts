import { Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROTOCOL_VERSION = 1

export const Endpoint = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  pid: Schema.Number,
  protocolVersion: Schema.Number
})
export type Endpoint = typeof Endpoint.Type

export const EndpointFromJson = Schema.fromJsonString(Endpoint)

// I-3: one well-known discovery file. YODEA_ENDPOINT_FILE (full path) and
// YODEA_HOME (parent dir) allow test/runtime isolation.
export const endpointFilePath = (): string =>
  process.env.YODEA_ENDPOINT_FILE ??
  join(process.env.YODEA_HOME ?? join(homedir(), ".yodea"), "server.json")
