import { Effect, Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  ClientLayer, ProjectClient,
  ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectInvalidInput
} from "@expand/client-ts"
import { adapter } from "./adapter"

const root = process.argv[2]
if (!root || root.startsWith("--")) { console.error("usage: bootstrap-projects <dir>"); process.exit(2) }

const subdirs = readdirSync(root).filter((n) => {
  try { return statSync(join(root, n)).isDirectory() } catch { return false }
})

const program = Effect.gen(function* () {
  const client = yield* ProjectClient
  const existing = yield* client.list({ includeArchived: true })
  const known = new Set(existing.projects.map((p) => String(p.name)))
  let created = 0
  let skipped = 0
  for (const name of subdirs) {
    if (known.has(name)) { skipped++; continue }
    const outcome = yield* client.create({ name, ensure: false, directory: join(root, name) }).pipe(
      Effect.map(() => "created" as const),
      Effect.catchTags({
        ProjectAlreadyExists: () => Effect.succeed("skipped" as const),
        ProjectDirectoryConflict: () => Effect.succeed("skipped" as const),
        ProjectDirectoryInvalid: () => Effect.succeed("skipped" as const),
        ProjectInvalidInput: () => Effect.succeed("skipped" as const)
      })
    )
    if (outcome === "created") created++
    else skipped++
  }
  console.log(`bootstrap: created ${created}, skipped ${skipped}`)
})

const runtime = ManagedRuntime.make(ClientLayer(adapter).pipe(Layer.provide(BunServices.layer)))
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => {
    console.error(err)
    // Let dispose() run the scope finalizers (socket close) *before* exiting.
    return runtime.dispose().finally(() => process.exit(1))
  }
)
