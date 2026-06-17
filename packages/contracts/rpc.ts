import { RpcGroup } from "effect/unstable/rpc"
import { ProjectRpcs } from "@yodea/contracts/rpc/projects"
import { ServerRpcs } from "@yodea/contracts/rpc/server"
import { StreamRpcs } from "@yodea/contracts/rpc/stream"

export class YodeaRpcs extends ProjectRpcs.merge(ServerRpcs, StreamRpcs) {}

// Keep `@yodea/contracts/rpc` exporting the project error classes (+ ProjectRpcs)
// so every existing import site resolves unchanged.
export * from "@yodea/contracts/rpc/projects"
