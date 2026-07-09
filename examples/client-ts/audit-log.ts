import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { appendFileSync } from "node:fs"
import { ProjectStore, ProjectStoreLayer } from "@expand/client-ts"
import { adapter } from "./adapter"

const outfile = process.argv[2]
if (!outfile || outfile.startsWith("--")) { console.error("usage: audit-log <outfile>"); process.exit(2) }

const program = Effect.scoped(Effect.gen(function* () {
  const store = yield* ProjectStore
  // `store.events` is a *tail* of the backend's event stream (PubSub-backed): only
  // events published *after* we subscribe are delivered — there is no backlog. So
  // we acquire the subscription first (`Stream.toPull` subscribes synchronously),
  // and only *then* announce readiness. A consumer that waits for this banner can
  // safely assume the audit log is actually tailing, not merely connected.
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
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => {
    console.error(err)
    // Let dispose() run the scope finalizers (socket close) *before* exiting.
    return runtime.dispose().finally(() => process.exit(1))
  }
)
