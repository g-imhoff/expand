import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { appendFileSync } from "node:fs"
import { ProjectStore, ProjectStoreLayer } from "@expand/client-ts"
import { adapter } from "./adapter"

const outfile = process.argv[2]
if (!outfile || outfile.startsWith("--")) { console.error("usage: audit-log <outfile>"); process.exit(2) }

const program = Effect.scoped(Effect.gen(function*() {
  const store = yield* ProjectStore
  const pull = yield* Stream.toPull(store.events)
  console.log(`audit-log: writing to ${outfile}`)
  yield* Effect.forever(
    Effect.flatMap(pull, (events) =>
      Effect.sync(() => {
        for (const se of events) {
          appendFileSync(outfile, JSON.stringify({
            seq: se.seq, tag: se.event._tag, projectId: se.event.projectId, at: se.event.occurredAt
          }) + "\n")
        }
      })
    )
  )
}))

const runtime = ManagedRuntime.make(ProjectStoreLayer(adapter).pipe(Layer.provide(BunServices.layer)))
try {
  await runtime.runPromise(program)
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await runtime.dispose()
}
