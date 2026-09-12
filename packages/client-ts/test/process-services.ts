import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ProcessControl } from "@expand/contracts/process-control"
import { ProcessServices as NodeProcessServices } from "../adapters/node-process-control"

export type ProcessServices = NodeServices.NodeServices | ProcessControl

export const ProcessServices = {
  layer: NodeProcessServices.layer,
  platformLayer: NodeProcessServices.platformLayer,
  processControlLayer: NodeProcessServices.processControlLayer,
  discoveryLayer: Layer.mergeAll(
    NodeProcessServices.platformLayer,
    Layer.succeed(ProcessControl, {
      currentPid: 100,
      probe: (pid: number) => Effect.succeed(pid === 2147483647 ? "dead" : "alive"),
      currentIdentity: () => Effect.sync((): undefined => undefined),
      identify: (pid: number) =>
        Effect.succeed(
          pid === 2147483647
            ? { status: "dead" as const }
            : { status: "alive" as const, identity: undefined }
        )
    })
  ),
  alivePid: 101
}
