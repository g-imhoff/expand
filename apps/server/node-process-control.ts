import { Effect, Layer } from "effect"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import {
  ProcessControl,
  ProcessProbeError,
  type ProcessStatus
} from "@expand/contracts/process-control"

export const nodeProcessControlLayer = Layer.sync(ProcessControl, () => ({
  currentPid: process.pid,
  probe
}))

export const ProcessServices = {
  layer: Layer.mergeAll(NodeServices.layer, nodeProcessControlLayer),
  platformLayer: NodeServices.layer,
  processControlLayer: nodeProcessControlLayer
}

export const ProcessFileSystem = {
  layer: NodeFileSystem.layer
}

const probe = Effect.fn("ServerNodeProcessControl.probe")(function*(pid: number) {
  return yield* Effect.try({
    try: () => process.kill(pid, 0),
    catch: (cause) => cause
  }).pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        const code = errorCode(cause)
        if (code === "ESRCH") return Effect.succeed<ProcessStatus>("dead")
        if (code === "EPERM") return Effect.succeed<ProcessStatus>("inaccessible")
        return Effect.fail(new ProcessProbeError({ pid, cause }))
      },
      onSuccess: () => Effect.succeed<ProcessStatus>("alive")
    })
  )
})

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object"
    && cause !== null
    && "code" in cause
    && typeof cause.code === "string"
    ? cause.code
    : undefined
