import { createContext } from "react"
import { Data, Layer, ManagedRuntime } from "effect"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type { Instance as InkInstance } from "ink"
import { Effect } from "effect"
import {
  ClientLayer,
  ClientSession,
  resolveBackendCommand,
  type BackendUnavailable
} from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { nodeAppContextLayer } from "@expand/tui/node-app-context"

export class TuiHostError extends Data.TaggedError("TuiHostError")<{
  readonly operation: "render" | "wait"
  readonly cause: unknown
}> {}

export interface TuiProgramDeps {
  readonly makeRuntime: () => ExpandRuntime
  readonly render: (runtime: ExpandRuntime) => Pick<InkInstance, "waitUntilExit" | "unmount">
}

export type ExpandRuntimeError = BackendUnavailable | Layer.Error<typeof nodeAppContextLayer>

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<
  ClientSession | ProjectClient | ServerClient,
  ExpandRuntimeError
>

export const RuntimeContext = createContext<ExpandRuntime | null>(null)

export const makeProductionRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    clientLayer(makeNodeAdapter({ backendCommand })).pipe(Layer.provide(ProcessServices.layer))
  )

export const tuiProgram = Effect.fn("Tui.tuiProgram")(function* (deps: TuiProgramDeps) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(deps.makeRuntime),
        (ownedRuntime) => ownedRuntime.disposeEffect
      )
      const ink = yield* Effect.acquireRelease(
        Effect.try({
          try: () => deps.render(runtime),
          catch: (cause) => new TuiHostError({ operation: "render", cause })
        }),
        (rendered) => Effect.sync(rendered.unmount)
      )
      yield* Effect.tryPromise(() => ink.waitUntilExit()).pipe(
        Effect.mapError((cause) => new TuiHostError({ operation: "wait", cause }))
      )
    })
  )
})

const backendCommand = Effect.suspend(() => {
  const sourceEntry = join(fileURLToPath(import.meta.url), "..", "..", "server", "main.ts")
  return resolveBackendCommand({
    execPath: process.execPath,
    runtimeArgs: ["--import", "tsx"],
    sourceEntry,
    binaryArgs: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "expand-server")]
  })
})

const clientLayer = (runtimeAdapter: Parameters<typeof ClientLayer>[0]) =>
  ClientLayer(runtimeAdapter).pipe(Layer.provide(nodeAppContextLayer))
