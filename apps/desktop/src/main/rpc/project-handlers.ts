import { Effect } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof YodeaRpcs>>

export const projectHandlers: Pick<
  Handlers,
  | "ProjectCreate"
  | "ProjectRename"
  | "ProjectChangeDirectory"
  | "ProjectArchive"
  | "ProjectRestore"
  | "ProjectSetMetadata"
  | "ProjectDelete"
  | "ProjectList"
> = {
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
    Effect.flatMap(ProjectStore, (s) => s.snapshot).pipe(
      Effect.map(({ projects, seq }) => ({
        projects: includeArchived ? projects : projects.filter((p) => !p.archived),
        seq
      }))
    )
}
