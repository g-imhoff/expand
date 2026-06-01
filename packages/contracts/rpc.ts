import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { DomainEvent } from "@yodea/contracts/events"
import { Project, ProjectCreateResult } from "@yodea/contracts/project"

// Typed RPC error: a name conflict on create. Schema-backed so it rides the wire.
export class ProjectAlreadyExists extends Schema.TaggedErrorClass<ProjectAlreadyExists>()(
  "ProjectAlreadyExists",
  { name: Schema.String }
) {}

export class YodeaRpcs extends RpcGroup.make(
  Rpc.make("Health", { success: Schema.String }),
  // Create a project. `ensure` makes it an idempotent no-op when the name exists.
  Rpc.make("ProjectCreate", {
    payload: { name: Schema.String, ensure: Schema.Boolean },
    success: ProjectCreateResult,
    error: ProjectAlreadyExists
  }),
  Rpc.make("ProjectList", { success: Schema.Array(Project) }),
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  Rpc.make("Events", { success: DomainEvent, stream: true })
) {}
