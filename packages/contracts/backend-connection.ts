import { Schema } from "effect"

export class LocalBackendConnection extends Schema.TaggedStruct("local", {}) {}

export class RemoteBackendConnection extends Schema.TaggedStruct("remote", {
  url: Schema.String,
  token: Schema.String
}) {}

export class BackendConnectionInvalid extends Schema.TaggedError<BackendConnectionInvalid>()(
  "BackendConnectionInvalid",
  { field: Schema.String, reason: Schema.String }
) {}

export const BackendConnection = Schema.Union([LocalBackendConnection, RemoteBackendConnection])
export type BackendConnection = typeof BackendConnection.Type
export type RemoteConnection = typeof RemoteBackendConnection.Type
export type LocalConnection = typeof LocalBackendConnection.Type

export const BackendConnectionFromJson = Schema.fromJsonString(BackendConnection)

export const BackendConnectionTestResult = Schema.Struct({
  reachable: Schema.Boolean,
  authorized: Schema.Boolean
})
export type BackendConnectionTestResult = typeof BackendConnectionTestResult.Type

export const normalizeRemoteUrl = (input: string): string => {
  const trimmed = input.trim()
  if (trimmed.length === 0) return trimmed
  const withScheme = /^wss?:\/\//i.test(trimmed)
    ? trimmed
    : trimmed.startsWith("127.") || trimmed.startsWith("localhost")
      ? `ws://${trimmed}`
      : `wss://${trimmed}`
  const parsed = new URL(withScheme)
  if (!parsed.pathname.endsWith("/rpc")) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/rpc`
  }
  return parsed.toString().replace(/\/$/, "").replace(/\/rpc$/, "/rpc")
}

export const remoteUrlFromHostPort = (host: string, port: number): string =>
  normalizeRemoteUrl(`${host.trim()}:${port}/rpc`)

export const isRemoteConnection = (connection: BackendConnection): connection is RemoteConnection =>
  connection._tag === "remote"

export const isLocalConnection = (connection: BackendConnection): connection is LocalConnection =>
  connection._tag === "local"

export type BackendConnectionPayloadShape = {
  readonly mode: "local" | "remote"
  readonly url?: string | undefined
  readonly token?: string | undefined
}

export const connectionFromPayload = (
  payload: BackendConnectionPayloadShape
): BackendConnection =>
  payload.mode === "local"
    ? { _tag: "local" }
    : { _tag: "remote", url: payload.url ?? "", token: payload.token ?? "" }

export const payloadFromConnection = (
  connection: BackendConnection
): BackendConnectionPayloadShape =>
  connection._tag === "local"
    ? { mode: "local" }
    : { mode: "remote", url: connection.url, token: connection.token }
