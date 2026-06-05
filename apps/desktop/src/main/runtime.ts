import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { makeNodeAdapter } from "@yodea/client-core/adapters/node"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type YodeaRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, never>

const backendCommand = (): ReadonlyArray<string> => {
  const override = process.env.YODEA_BACKEND_CMD
  if (override) return JSON.parse(override) as ReadonlyArray<string>
  return ["bun", join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "server", "main.ts")]
}

export const makeRuntime = (): YodeaRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeNodeAdapter({ backendCommand: backendCommand() })).pipe(
      Layer.provide(NodeServices.layer)
    )
  )
