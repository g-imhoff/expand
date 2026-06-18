import { RpcGroup } from "effect/unstable/rpc"
import { ProjectRpcs } from "@yodea/contracts/rpc/projects"
import { ServerRpcs } from "@yodea/contracts/rpc/server"
import { StreamRpcs } from "@yodea/contracts/rpc/stream"

export class YodeaRpcs extends RpcGroup.make().merge(ProjectRpcs, ServerRpcs, StreamRpcs) { }

export {
  ProjectAlreadyExists,
  ProjectNotFound,
  ProjectNameConflict,
  ProjectDirectoryInvalid,
  ProjectDirectoryConflict,
  ProjectInvalidInput
} from "@yodea/contracts/rpc/projects"
