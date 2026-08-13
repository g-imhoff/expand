import { RpcGroup } from "effect/unstable/rpc"
import { ProjectRpcs } from "@expand/contracts/rpc/projects"
import { ServerRpcs } from "@expand/contracts/rpc/server"
import { StreamRpcs } from "@expand/contracts/rpc/stream"

export class ExpandRpcs extends RpcGroup
  .make()
  .merge(ProjectRpcs, ServerRpcs, StreamRpcs)
{ }

export {
  ProjectAlreadyExists,
  ProjectNotFound,
  ProjectNameConflict,
  ProjectDirectoryInvalid,
  ProjectDirectoryConflict,
  ProjectInvalidInput
} from "@expand/contracts/rpc/projects"
