import { Schema } from "effect"

export const PROTOCOL_VERSION = 2

export class Endpoint extends Schema.Opaque<Endpoint>()(
  Schema.Struct({
    url: Schema.String,
    token: Schema.String,
    pid: Schema.Number,
    protocolVersion: Schema.Number
  })
) {}

export const EndpointFromJson = Schema.fromJsonString(Endpoint)
