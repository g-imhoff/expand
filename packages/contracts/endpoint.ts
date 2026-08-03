import { Schema } from "effect"

export class Endpoint extends Schema.Opaque<Endpoint>()(
  Schema.Struct({
    url: Schema.String,
    token: Schema.String,
    pid: Schema.Number,
    protocolVersion: Schema.Number
  })
) {}

export { PROTOCOL_VERSION } from "./rpc/version.js"

export const EndpointFromJson = Schema.fromJsonString(Endpoint)
