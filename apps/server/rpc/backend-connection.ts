import type { RpcGroup } from "effect/rpc"
import { Effect } from "effect"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { BackendConnectionInvalid } from "@expand/contracts/backend-connection"

export const backendConnectionHandlers = {
  BackendConnectionGet: (): Effect.Effect<never, BackendConnectionInvalid> =>
    Effect.fail(new BackendConnectionInvalid({ field: "mode", reason: "desktop manages backend connection" })),
  BackendConnectionSet: (): Effect.Effect<never, BackendConnectionInvalid> =>
    Effect.fail(new BackendConnectionInvalid({ field: "mode", reason: "desktop manages backend connection" })),
  BackendConnectionTest: (): Effect.Effect<never, BackendConnectionInvalid> =>
    Effect.fail(new BackendConnectionInvalid({ field: "mode", reason: "desktop manages backend connection" }))
} satisfies Pick<Handlers, "BackendConnectionGet" | "BackendConnectionSet" | "BackendConnectionTest">

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
