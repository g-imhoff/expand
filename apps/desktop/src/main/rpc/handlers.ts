import { Effect, Stream, SubscriptionRef } from "effect"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"

// The renderer↔main contract handlers. They delegate to the shared ProjectStore
// (which itself talks to the backend). The contract declares no client-facing
// error for the commands, so the store's RpcClientError is discharged with
// `Effect.orDie` — matching the backend's own handler convention
// (apps/cli/server/rpc-handlers.ts). Connect is a trivial main-side presence
// (the backend connection/presence is already held by main's ProjectStore).
export const DesktopRpcHandlers = YodeaRpcs.toLayer({
  Health: () => Effect.succeed("ok"),
  ProjectCreate: ({ name }) =>
    Effect.flatMap(ProjectStore, (s) => s.createProject(name)).pipe(
      Effect.map((project) => ({ created: true, project })),
      Effect.orDie
    ),
  ProjectList: ({ includeArchived }) =>
    Effect.flatMap(ProjectStore, (s) => SubscriptionRef.get(s.projects)).pipe(
      Effect.map((ps) => includeArchived ? ps : ps.filter((p) => !p.archived))
    ),
  Connect: () => Stream.make(true).pipe(Stream.concat(Stream.never)),
  Events: () => Stream.unwrap(Effect.map(ProjectStore, (s) => s.events))
})
