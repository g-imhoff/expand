import { Effect } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ProjectClient } from "@expand/client-ts/project"
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
  ProjectCreate: (payload) =>
    dieOnRpcClientError(
      Effect.flatMap(ProjectClient, (client) => client.create(payload))
    ),
  ProjectRename: (payload) =>
    dieOnRpcClientError(Effect.flatMap(ProjectClient, (client) => client.rename(payload))),
  ProjectChangeDirectory: (payload) =>
    dieOnRpcClientError(Effect.flatMap(ProjectClient, (client) => client.changeDirectory(payload))),
  ProjectArchive: (payload) =>
    dieOnRpcClientError(Effect.flatMap(ProjectClient, (client) => client.archive(payload))),
  ProjectRestore: (payload) =>
    dieOnRpcClientError(Effect.flatMap(ProjectClient, (client) => client.restore(payload))),
  ProjectSetMetadata: (payload) =>
    dieOnRpcClientError(
      Effect.flatMap(ProjectClient, (client) => client.setMetadata(payload))
    ),
  ProjectDelete: (payload) =>
    dieOnRpcClientError(Effect.flatMap(ProjectClient, (client) => client.delete(payload))),
  ProjectList: (payload) =>
    dieOnRpcClientError(Effect.flatMap(ProjectClient, (client) => client.list(payload)))
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
