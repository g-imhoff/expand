import { Rpc, RpcGroup } from "effect/rpc"
import { Schema } from "effect"
import { BackendConnectionInvalid } from "@expand/contracts/backend-connection"
import { BackendConnectionTestResult } from "@expand/contracts/backend-connection"

export interface BackendConnectionPayload {
  readonly mode: "local" | "remote"
  readonly url?: string | undefined
  readonly token?: string | undefined
}

export class BackendConnectionRpcs extends RpcGroup.make(
  Rpc.make("BackendConnectionGet", {
    success: Schema.Struct({
      mode: Schema.Literals(["local", "remote"]),
      url: Schema.optional(Schema.String),
      token: Schema.optional(Schema.String)
    }),
    error: BackendConnectionInvalid
  }),
  Rpc.make("BackendConnectionSet", {
    payload: Schema.Struct({
      mode: Schema.Literals(["local", "remote"]),
      url: Schema.optional(Schema.String),
      token: Schema.optional(Schema.String)
    }),
    success: Schema.Struct({
      mode: Schema.Literals(["local", "remote"]),
      url: Schema.optional(Schema.String),
      token: Schema.optional(Schema.String)
    }),
    error: BackendConnectionInvalid
  }),
  Rpc.make("BackendConnectionTest", {
    payload: Schema.Struct({
      mode: Schema.Literals(["local", "remote"]),
      url: Schema.optional(Schema.String),
      token: Schema.optional(Schema.String)
    }),
    success: BackendConnectionTestResult,
    error: BackendConnectionInvalid
  })
) {}
