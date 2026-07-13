import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { appendFileSync } from "node:fs"
import { ClientLayer } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { adapter } from "./adapter"

const outfile = process.argv[2]
if (!outfile || outfile.startsWith("--")) { console.error("usage: audit-log <outfile>"); process.exit(2) }

const program = Effect.scoped(Effect.gen(function*() {
  const client = yield* ProjectClient
  const pull = yield* Stream.toPull(client.events())
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

const runtime = ManagedRuntime.make(ClientLayer(adapter).pipe(Layer.provide(BunServices.layer)))
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => {
    console.error(err)
    return runtime.dispose().finally(() => process.exit(1))
  }
)
