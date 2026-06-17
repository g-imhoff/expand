import { RpcGroup } from "effect/unstable/rpc"
import { ProjectRpcs } from "@yodea/contracts/rpc/projects"
import { ServerRpcs } from "@yodea/contracts/rpc/server"
import { StreamRpcs } from "@yodea/contracts/rpc/stream"

// Compose from a neutral empty base so no feature group is privileged as "the
// base" — every feature is an equal member, and adding one is just another arg.
export class YodeaRpcs extends RpcGroup.make().merge(ProjectRpcs, ServerRpcs, StreamRpcs) {}

// Re-export the project error classes by name (never `export *`) so the public
// surface stays visible and dead-code analysis can see each binding.
export {
  ProjectAlreadyExists,
  ProjectNotFound,
  ProjectNameConflict,
  ProjectDirectoryInvalid,
  ProjectDirectoryConflict,
  ProjectInvalidInput
} from "@yodea/contracts/rpc/projects"
