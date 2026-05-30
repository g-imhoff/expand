import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { makeNodeAdapter } from "@yodea/client-core/adapters/node"
import { resolve } from "node:path"

export type YodeaRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, never>

// How the desktop app launches the backend. Override with YODEA_BACKEND_CMD
// (JSON array). Dev default: run the source entry with bun. Packaged: ship the
// compiled `yodea` binary and set YODEA_BACKEND_CMD=["<path>/yodea","server"].
const backendCommand = (): ReadonlyArray<string> => {
  const override = process.env.YODEA_BACKEND_CMD
  if (override) return JSON.parse(override) as ReadonlyArray<string>
  return ["bun", resolve(process.cwd(), "../../apps/cli/cli/main.ts"), "server"]
}

export const makeRuntime = (): YodeaRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeNodeAdapter({ backendCommand: backendCommand() })).pipe(
      Layer.provide(NodeServices.layer)
    )
  )
