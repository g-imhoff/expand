import { RpcGroup } from "effect/rpc"
import { AutomationRpcs } from "@expand/contracts/rpc/automation"
import { ProjectRpcs } from "@expand/contracts/rpc/projects"
import { ServerRpcs } from "@expand/contracts/rpc/server"
import { StreamRpcs } from "@expand/contracts/rpc/stream"
import { BackendConnectionRpcs } from "@expand/contracts/rpc/backend-connection"

export class ExpandRpcs extends RpcGroup
  .make()
  .merge(ProjectRpcs, ServerRpcs, StreamRpcs, AutomationRpcs, BackendConnectionRpcs)
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
  AutomationConflict,
  AutomationInvalid,
  AutomationNotFound,
  AutomationStorageFailed
} from "@expand/contracts/rpc/automation-schemas"

export { BackendConnectionInvalid } from "@expand/contracts/backend-connection"
