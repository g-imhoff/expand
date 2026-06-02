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
  // Surface the typed domain errors (ProjectNotFound/ProjectNameConflict) so the
  // renderer's contract-derived RpcClient gets them; the store's transport-level
  // RpcClientError is not part of the contract, so discharge it as a defect.
  ProjectRename: ({ id, name }) =>
    Effect.flatMap(ProjectStore, (s) => s.renameProject(id, name)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  // Surface the typed directory errors (ProjectNotFound/ProjectDirectoryInvalid/
  // ProjectDirectoryConflict); discharge the store's transport-level
  // RpcClientError as a defect (it is not part of the contract).
  ProjectChangeDirectory: ({ id, directory }) =>
    Effect.flatMap(ProjectStore, (s) => s.changeDirectory(id, directory)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  // Surface the typed ProjectNotFound; discharge the store's transport-level
  // RpcClientError as a defect (it is not part of the contract).
  ProjectArchive: ({ id }) =>
    Effect.flatMap(ProjectStore, (s) => s.archiveProject(id)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  ProjectRestore: ({ id }) =>
    Effect.flatMap(ProjectStore, (s) => s.restoreProject(id)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  // Surface the typed ProjectNotFound (replace-style metadata); discharge the
  // store's transport-level RpcClientError as a defect (not part of the contract).
  ProjectSetMetadata: ({ id, description, tags }) =>
    Effect.flatMap(ProjectStore, (s) =>
      s.setMetadata(id, {
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {})
      })
    ).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  // Surface the typed ProjectNotFound (soft tombstone); discharge the store's
  // transport-level RpcClientError as a defect (it is not part of the contract).
  // No orDie on the success path — the renderer's RpcClient must receive ProjectNotFound.
  ProjectDelete: ({ id }) =>
    Effect.flatMap(ProjectStore, (s) => s.deleteProject(id)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  ProjectList: ({ includeArchived }) =>
    Effect.flatMap(ProjectStore, (s) => SubscriptionRef.get(s.projects)).pipe(
      Effect.map((ps) => includeArchived ? ps : ps.filter((p) => !p.archived))
    ),
  Connect: () => Stream.make(true).pipe(Stream.concat(Stream.never)),
  Events: () => Stream.unwrap(Effect.map(ProjectStore, (s) => s.events))
})
