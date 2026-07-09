import { Effect, Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import { existsSync } from "node:fs"
import { ClientLayer } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { adapter } from "./adapter"

const program = Effect.gen(function*() {
  const client = yield* ProjectClient
  const { projects } = yield* client.list({ includeArchived: false })
  let archived = 0
  for (const p of projects) {
    if (p.directory !== null && !existsSync(p.directory)) {
      yield* client.archive({ id: String(p.id) })
      archived++
      console.log(`  archived ${String(p.name)} (missing dir: ${p.directory})`)
    }
  }
  console.log(`archive-stale: archived ${archived} of ${projects.length} active`)
})

const runtime = ManagedRuntime.make(ClientLayer(adapter).pipe(Layer.provide(BunServices.layer)))
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => {
    console.error(err)
    return runtime.dispose().finally(() => process.exit(1))
  }
)
