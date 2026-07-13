import { Effect, Fiber, Layer, ManagedRuntime, Option, Ref, Stream, SubscriptionRef } from "effect"
import { BunServices } from "@effect/platform-bun"
import { appendFileSync } from "node:fs"
import { ClientLayer, ClientSession } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { adapter } from "./adapter"

export const runAuditLog = (outfile: string) => Effect.scoped(Effect.gen(function*() {
  const session = yield* ClientSession
  const client = yield* ProjectClient
  const cursor = yield* Ref.make(0)
  const active = yield* Ref.make(Option.none<Fiber.Fiber<void, never>>())
  const interruptActive = Ref.getAndSet(active, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber)
      })
    )
  )
  console.log(`audit-log: writing to ${outfile}`)
  yield* SubscriptionRef.changes(session.status).pipe(
    Stream.runForEach((status) =>
      Effect.gen(function* () {
        yield* interruptActive
        if (status === "connected") {
          const fromSeq = yield* Ref.get(cursor)
          const fiber = yield* Effect.forkScoped(
            client.events({ fromSeq }).pipe(
              Stream.runForEach((se) =>
                Ref.modify(cursor, (lastSeq) =>
                  se.seq <= lastSeq
                    ? [false, lastSeq] as const
                    : [true, se.seq] as const
                ).pipe(
                  Effect.flatMap((shouldAppend) =>
                    shouldAppend
                      ? Effect.sync(() => {
                          appendFileSync(outfile, JSON.stringify({
                            seq: se.seq,
                            tag: se.event._tag,
                            projectId: se.event.projectId,
                            at: se.event.occurredAt
                          }) + "\n")
                        })
                      : Effect.void
                  )
                )
              ),
              Effect.catch(() => Effect.void)
            )
          )
          yield* Ref.set(active, Option.some(fiber))
        }
      })
    )
  )
}))

if (import.meta.main) {
  const outfile = process.argv[2]
  if (!outfile || outfile.startsWith("--")) { console.error("usage: audit-log <outfile>"); process.exit(2) }
  const runtime = ManagedRuntime.make(ClientLayer(adapter).pipe(Layer.provide(BunServices.layer)))
  runtime.runPromise(runAuditLog(outfile)).then(
    () => runtime.dispose(),
    (err) => {
      console.error(err)
      return runtime.dispose().finally(() => process.exit(1))
    }
  )
}
