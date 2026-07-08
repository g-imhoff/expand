import { Effect } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ProjectUseCases } from "@expand/server/application/projects/use-cases"
import { ProjectProjection } from "@expand/server/application/projections"
import { guard } from "@expand/server/rpc/guard"

export const projectHandlers = {
  ProjectCreate: ({ name, ensure, directory }) =>
    guard(Effect.flatMap(ProjectUseCases, (u) => u.createProject(name, ensure, directory))),
  ProjectRename: ({ id, name }) =>
    guard(Effect.flatMap(ProjectUseCases, (u) => u.renameProject(id, name))),
  ProjectChangeDirectory: ({ id, directory }) =>
    guard(Effect.flatMap(ProjectUseCases, (u) => u.changeDirectory(id, directory))),
  ProjectArchive: ({ id }) =>
    guard(Effect.flatMap(ProjectUseCases, (u) => u.archiveProject(id))),
  ProjectRestore: ({ id }) =>
    guard(Effect.flatMap(ProjectUseCases, (u) => u.restoreProject(id))),
  ProjectSetMetadata: ({ id, description, tags }) =>
    guard(Effect.flatMap(ProjectUseCases, (u) =>
      u.setMetadata(id, {
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {})
      })
    )),
  ProjectDelete: ({ id }) =>
    guard(Effect.flatMap(ProjectUseCases, (u) => u.deleteProject(id))),
  ProjectList: ({ includeArchived }) =>
    Effect.flatMap(ProjectProjection, (p) => p.snapshot).pipe(
      Effect.map(({ projects, seq }) => ({
        projects: includeArchived ? projects : projects.filter((x) => !x.archived),
        seq
      })),
      Effect.orDie
    )
} satisfies Pick<
  Handlers,
  | "ProjectCreate" | "ProjectRename" | "ProjectChangeDirectory" | "ProjectArchive"
  | "ProjectRestore" | "ProjectSetMetadata" | "ProjectDelete" | "ProjectList"
>

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
