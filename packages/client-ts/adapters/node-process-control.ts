import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { readFileSync } from "node:fs"
import {
  ProcessControl,
  ProcessProbeError,
  type ProcessIdentity,
  type ProcessStatus
} from "@expand/contracts/process-control"
import {
  formatIncarnation,
  parseProcStatStarttime
} from "@expand/contracts/process-incarnation"

export const nodeProcessControlLayer = Layer.sync(ProcessControl, () => ({
  currentPid: process.pid,
  probe,
  currentIdentity,
  identify
}))

export const ProcessServices = {
  layer: Layer.mergeAll(NodeServices.layer, nodeProcessControlLayer),
  platformLayer: NodeServices.layer,
  processControlLayer: nodeProcessControlLayer
}

const probe = Effect.fn("NodeProcessControl.probe")(function*(pid: number) {
  return yield* Effect.try({
    try: () => process.kill(pid, 0),
    catch: (cause) => new ProcessProbeError({ pid, cause })
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const code = errorCode(error.cause)
        if (code === "ESRCH") return Effect.succeed<ProcessStatus>("dead")
        if (code === "EPERM") return Effect.succeed<ProcessStatus>("inaccessible")
        return Effect.fail(error)
      },
      onSuccess: () => Effect.succeed<ProcessStatus>("alive")
    })
  )
})

const currentIdentity = Effect.fn("NodeProcessControl.currentIdentity")(function*() {
  return readIncarnation(process.pid)
})

const identify = Effect.fn("NodeProcessControl.identify")(function*(pid: number) {
  return yield* Effect.try({
    try: () => process.kill(pid, 0),
    catch: (cause) => new ProcessProbeError({ pid, cause })
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const code = errorCode(error.cause)
        if (code === "ESRCH") return Effect.succeed<ProcessIdentity>({ status: "dead" })
        if (code === "EPERM") {
          return Effect.succeed<ProcessIdentity>({
            status: "inaccessible",
            identity: readIncarnation(pid)
          })
        }
        return Effect.fail(error)
      },
      onSuccess: () => {
        const stat = readStat(pid)
        if (stat !== undefined) {
          return Effect.succeed<ProcessIdentity>({ status: "alive", identity: statIdentity(stat) })
        }
        if (!hasProcfs()) {
          return Effect.succeed<ProcessIdentity>({ status: "alive", identity: undefined })
        }
        return Effect.succeed<ProcessIdentity>({ status: "dead" })
      }
    })
  )
})

const readIncarnation = (pid: number): string | undefined => {
  const stat = readStat(pid)
  if (stat === undefined) return undefined
  return statIdentity(stat)
}

const readStat = (pid: number): string | undefined => {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return undefined
  }
}

const statIdentity = (stat: string): string | undefined => {
  const starttime = parseProcStatStarttime(stat)
  if (starttime === undefined) return undefined
  return formatIncarnation(starttime, readBootId())
}

const readBootId = (): string | undefined => {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    return bootId === "" ? undefined : bootId
  } catch {
    return undefined
  }
}

const hasProcfs = (): boolean => {
  try {
    readFileSync("/proc/self/stat", "utf8")
    return true
  } catch {
    return false
  }
}

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object"
    && cause !== null
    && "code" in cause
    && typeof cause.code === "string"
    ? cause.code
    : undefined
