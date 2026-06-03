import { Effect, Stream, SubscriptionRef } from "effect"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"

export const DesktopRpcHandlers = YodeaRpcs.toLayer({
  Health: () => Effect.succeed("ok"),
  ProjectCreate: ({ name, directory }) =>
    Effect.flatMap(ProjectStore, (s) => s.createProject(name, directory)).pipe(
      Effect.map((project) => ({ created: true, project })),
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  ProjectRename: ({ id, name }) =>
    Effect.flatMap(ProjectStore, (s) => s.renameProject(id, name)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  ProjectChangeDirectory: ({ id, directory }) =>
    Effect.flatMap(ProjectStore, (s) => s.changeDirectory(id, directory)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  ProjectArchive: ({ id }) =>
    Effect.flatMap(ProjectStore, (s) => s.archiveProject(id)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  ProjectRestore: ({ id }) =>
    Effect.flatMap(ProjectStore, (s) => s.restoreProject(id)).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
  ProjectSetMetadata: ({ id, description, tags }) =>
    Effect.flatMap(ProjectStore, (s) =>
      s.setMetadata(id, {
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {})
      })
    ).pipe(
      Effect.catchTag("RpcClientError", (e) => Effect.die(e))
    ),
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
