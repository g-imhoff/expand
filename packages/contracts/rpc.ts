import { RpcGroup } from "effect/rpc"
import { AutomationRpcs } from "@expand/contracts/rpc/automation"
import { ProjectRpcs } from "@expand/contracts/rpc/projects"
import { ServerRpcs } from "@expand/contracts/rpc/server"
import { StreamRpcs } from "@expand/contracts/rpc/stream"

export class ExpandRpcs extends RpcGroup
  .make()
  .merge(ProjectRpcs, ServerRpcs, StreamRpcs, AutomationRpcs)
{ }

export {
  ProjectAlreadyExists,
  ProjectNotFound,
  ProjectNameConflict,
  ProjectDirectoryInvalid,
  ProjectDirectoryConflict,
  ProjectInvalidInput
} from "@expand/contracts/rpc/projects"

export {
  AutomationInvalid,
  AutomationConflict,
  AutomationNotFound,
  AutomationStorageFailed
} from "@expand/contracts/rpc/automation-schemas"
