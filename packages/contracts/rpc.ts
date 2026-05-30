import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { DomainEvent } from "@yodea/contracts/events"
import { Project } from "@yodea/contracts/project"

export class YodeaRpcs extends RpcGroup.make(
  // Liveness query.
  Rpc.make("Health", { success: Schema.String }),
  // Command: create a project, returns the created read-model.
  Rpc.make("ProjectCreate", {
    payload: { name: Schema.String },
    success: Project
  }),
  // Query: list all projects (projection).
  Rpc.make("ProjectList", { success: Schema.Array(Project) }),
  // Presence channel (I-4): a frontend subscribes on connect and holds it for
  // the lifetime of its work. The server emits one `true` immediately so the
  // client can confirm the connection was registered, then keeps it open until
  // the socket drops.
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  // Live stream: every DomainEvent the backend commits (for read-model frontends).
  Rpc.make("Events", { success: DomainEvent, stream: true })
) {}
