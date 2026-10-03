import { Effect, ManagedRuntime, Redacted } from "effect"
import type { FileSystem } from "effect"
import type { RuntimeAdapter } from "@expand/client-ts"
import { ClientSession, type BackendUnavailable } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { AutomationClient } from "@expand/client-ts/automation"
import {
  RemoteClientLayer,
  resolveRemoteEndpoint,
  withoutLocalSpawn,
  type RemoteEndpoint,
  type RemoteTargetInput
} from "@expand/client-ts/remote"
import { readRemoteConfig, resolveRemoteToken, type SafeStorageLike } from "@expand/desktop/main/runtime/remote-config"

export interface RemoteRuntimeInput {
  readonly target: RemoteTargetInput
  readonly envToken: string | undefined
  readonly configFile: string | undefined
  readonly safeStorage: SafeStorageLike | undefined
}

export type RemoteRuntime = ManagedRuntime.ManagedRuntime<
  ClientSession | ProjectClient | ServerClient | AutomationClient,
  BackendUnavailable
>

export const makeRemoteAdapter = (
  protocolLayer: RuntimeAdapter["protocolLayer"]
): RuntimeAdapter =>
  withoutLocalSpawn({
    protocolLayer,
    spawnBackend: () => Effect.die("remote adapter has no local backend")
  })

export const makeRemoteRuntime = (
  protocolLayer: RuntimeAdapter["protocolLayer"],
  endpoint: RemoteEndpoint
): RemoteRuntime => ManagedRuntime.make(RemoteClientLayer(makeRemoteAdapter(protocolLayer), endpoint))

export const resolveRemoteRuntimeEndpoint = Effect.fn("DesktopRemote.resolveRemoteRuntimeEndpoint")(function*(
  input: RemoteRuntimeInput
): Effect.fn.Return<RemoteEndpoint, BackendUnavailable, FileSystem.FileSystem> {
  const stored = input.configFile === undefined
    ? undefined
    : yield* readRemoteConfig(input.configFile)
  const fallback = typeof input.target.token === "string"
    ? Redacted.make(input.target.token)
    : input.target.token
  const token = yield* resolveRemoteToken(input.envToken, stored, input.safeStorage).pipe(
    Effect.orElseSucceed(() => fallback)
  )
  if (stored !== undefined) {
    return yield* resolveRemoteEndpoint({ url: stored.url, token })
  }
  return yield* resolveRemoteEndpoint({
    host: input.target.host,
    port: input.target.port,
    url: input.target.url,
    secure: input.target.secure,
    token
  })
})
