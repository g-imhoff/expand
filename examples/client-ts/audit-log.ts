import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { appendFileSync } from "node:fs"
import { ProjectStore, ProjectStoreLayer } from "@expand/client-ts"
import { adapter } from "./adapter"

const outfile = process.argv[2]
if (!outfile || outfile.startsWith("--")) { console.error("usage: audit-log <outfile>"); process.exit(2) }

const program = Effect.gen(function* () {
  const store = yield* ProjectStore
  console.log(`audit-log: writing to ${outfile}`)
  yield* Stream.runForEach(store.events, (se) =>
    Effect.sync(() => {
      appendFileSync(outfile, JSON.stringify({
        seq: se.seq, tag: se.event._tag, projectId: se.event.projectId, at: se.event.occurredAt
      }) + "\n")
    })
  )
})

const runtime = ManagedRuntime.make(ProjectStoreLayer(adapter).pipe(Layer.provide(BunServices.layer)))
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => { console.error(err); runtime.dispose(); process.exit(1) }
)
