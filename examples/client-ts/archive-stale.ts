import { Effect, Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { existsSync } from "node:fs"
import { clientLayer } from "./node-app-context"
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

const runtime = ManagedRuntime.make(clientLayer(adapter).pipe(Layer.provide(NodeServices.layer)))
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => {
    console.error(err)
    return runtime.dispose().finally(() => process.exit(1))
  }
)
