import { Effect, Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import { existsSync } from "node:fs"
import { ClientLayer, ProjectClient } from "@expand/client-ts"
import { adapter } from "./adapter"

const program = Effect.gen(function* () {
  const client = yield* ProjectClient
  const { projects } = yield* client.list({ includeArchived: false }) // active only
  const active = projects.filter((p) => !p.archived)
  let archived = 0
  for (const p of active) {
    if (p.directory !== null && !existsSync(p.directory)) {
      yield* client.archive({ id: String(p.id) })
      archived++
      console.log(`  archived ${String(p.name)} (missing dir: ${p.directory})`)
    }
  }
  console.log(`archive-stale: archived ${archived} of ${active.length} active`)
})

const runtime = ManagedRuntime.make(ClientLayer(adapter).pipe(Layer.provide(BunServices.layer)))
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => { console.error(err); runtime.dispose(); process.exit(1) }
)
