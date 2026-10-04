import { Context, Effect, Ref } from "effect"
import type { RpcGroup } from "effect/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { BackendConnection } from "@expand/contracts/backend-connection"
import {
  connectionFromPayload,
  payloadFromConnection
} from "@expand/contracts/backend-connection"
import {
  testRemoteConnection,
  validateConnection,
  writeRemoteConnection
} from "@expand/client-ts/backend-connection"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"

export class BackendConnectionStore extends Context.Service<BackendConnectionStore, {
  readonly get: Effect.Effect<BackendConnection>
  readonly set: (connection: BackendConnection) => Effect.Effect<BackendConnection>
}>()("expand/desktop/BackendConnectionStore") {}

export const makeBackendConnectionStore = (initial?: BackendConnection) =>
  Effect.map(Ref.make<BackendConnection>(initial ?? { _tag: "local" }), (ref) =>
    BackendConnectionStore.of({
      get: Ref.get(ref),
      set: (connection) => Ref.set(ref, connection).pipe(Effect.as(connection))
    })
  )

export const backendConnectionHandlers: Pick<
  Handlers,
  "BackendConnectionGet" | "BackendConnectionSet" | "BackendConnectionTest"
> = {
  BackendConnectionGet: () =>
    Effect.flatMap(BackendConnectionStore, (store) =>
      Effect.map(store.get, (connection) => ({
        mode: payloadFromConnection(connection).mode,
        ...(payloadFromConnection(connection).url !== undefined
          ? { url: payloadFromConnection(connection).url as string }
          : {}),
        ...(payloadFromConnection(connection).token !== undefined
          ? { token: payloadFromConnection(connection).token as string }
          : {})
      } as const))),
  BackendConnectionSet: (payload) => {
    const connection = connectionFromPayload(payload)
    return Effect.gen(function*() {
      const store = yield* BackendConnectionStore
      yield* validateConnection(connection)
      yield* writeRemoteConnection(connection).pipe(
        Effect.catchTag("BackendUnavailable", (cause) => Effect.die(cause))
      )
      const stored = yield* store.set(connection)
      return payloadFromConnection(stored) as {
        readonly mode: "local" | "remote"
        readonly url?: string | undefined
        readonly token?: string | undefined
      }
    })
  },
  BackendConnectionTest: (payload) => {
    const connection = connectionFromPayload(payload)
    const testAdapter = makeNodeAdapter({ backendCommand: Effect.succeed([] as const) })
    return Effect.flatMap(validateConnection(connection), () =>
      testRemoteConnection(testAdapter, connection))
  }
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
