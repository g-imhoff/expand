import { Effect } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ProjectStore } from "@expand/client-ts/project"
import { dieOnRpcClientError } from "@expand/desktop/main/rpc/guard"

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
    dieOnRpcClientError(
      Effect.flatMap(ProjectStore, (s) => s.createProject(name, directory)).pipe(
        Effect.map((project) => ({ created: true, project }))
      )
    ),
  ProjectRename: ({ id, name }) =>
    dieOnRpcClientError(Effect.flatMap(ProjectStore, (s) => s.renameProject(id, name))),
  ProjectChangeDirectory: ({ id, directory }) =>
    dieOnRpcClientError(Effect.flatMap(ProjectStore, (s) => s.changeDirectory(id, directory))),
  ProjectArchive: ({ id }) =>
    dieOnRpcClientError(Effect.flatMap(ProjectStore, (s) => s.archiveProject(id))),
  ProjectRestore: ({ id }) =>
    dieOnRpcClientError(Effect.flatMap(ProjectStore, (s) => s.restoreProject(id))),
  ProjectSetMetadata: ({ id, description, tags }) =>
    dieOnRpcClientError(
      Effect.flatMap(ProjectStore, (s) =>
        s.setMetadata(id, {
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {})
        })
      )
    ),
  ProjectDelete: ({ id }) =>
    dieOnRpcClientError(Effect.flatMap(ProjectStore, (s) => s.deleteProject(id))),
  ProjectList: ({ includeArchived }) =>
    Effect.flatMap(ProjectStore, (s) => s.snapshot).pipe(
      Effect.map(({ projects, seq }) => ({
        projects: includeArchived ? projects : projects.filter((p) => !p.archived),
        seq
      }))
    )
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
