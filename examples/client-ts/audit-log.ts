import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Ref, Stream, SubscriptionRef } from "effect"
import { NodeServices } from "@effect/platform-node"
import { appendFileSync } from "node:fs"
import { ClientLayer, ClientSession } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { adapter } from "./adapter"

export const runAuditLog = (outfile: string) => Effect.scoped(Effect.gen(function*() {
  const session = yield* ClientSession
  const client = yield* ProjectClient
  const cursor = yield* Ref.make(0)
  const failed = yield* Deferred.make<never>()
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
  const statuses = SubscriptionRef.changes(session.status).pipe(
    Stream.runForEach((status) =>
      Effect.gen(function* () {
        yield* interruptActive
        if (status === "connected") {
          const fromSeq = yield* Ref.get(cursor)
          const fiber = yield* Effect.forkScoped(
            client.events({ fromSeq }).pipe(
              Stream.runForEach((se) =>
                Ref.get(cursor).pipe(
                  Effect.flatMap((lastSeq) =>
                    se.seq <= lastSeq
                      ? Effect.void
                      : Effect.sync(() => {
                          appendFileSync(outfile, JSON.stringify({
                            seq: se.seq,
                            tag: se.event._tag,
                            projectId: se.event.projectId,
                            at: se.event.occurredAt
                          }) + "\n")
                        }).pipe(Effect.andThen(Ref.set(cursor, se.seq)))
                  )
                )
              ),
              Effect.catch(() => Effect.void),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                  ? Deferred.failCause(failed, exit.cause).pipe(Effect.asVoid)
                  : Effect.void
              )
            )
          )
          yield* Ref.set(active, Option.some(fiber))
        }
      })
    )
  )
  yield* Effect.raceFirst(statuses, Deferred.await(failed))
}))

if (import.meta.main) {
  const outfile = process.argv[2]
  if (!outfile || outfile.startsWith("--")) { console.error("usage: audit-log <outfile>"); process.exit(2) }
  const runtime = ManagedRuntime.make(clientLayer(adapter).pipe(Layer.provide(NodeServices.layer)))
  runtime.runPromise(runAuditLog(outfile)).then(
    () => runtime.dispose(),
    (err) => {
      console.error(err)
      return runtime.dispose().finally(() => process.exit(1))
    }
  )
}

function clientLayer(runtimeAdapter: Parameters<typeof ClientLayer>[0]) {
  return ClientLayer(runtimeAdapter).pipe(Layer.provide(appContextLayer))
}

const appContextLayer = (
  adapter as typeof adapter & {
    readonly nodeAppContextLayer: typeof import("./node-app-context").nodeAppContextLayer
  }
).nodeAppContextLayer
