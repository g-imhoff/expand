import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Layer, Cause, Console, Data, Deferred, Effect, Exit, Fiber, FileSystem, Option, Ref, Schema, Stdio, Stream, SubscriptionRef } from "effect"
import { ClientSession } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { adapter } from "./adapter"
import { clientLayer } from "./client-layer"

export class AuditInvalidInputError extends Data.TaggedError("AuditInvalidInputError")<{
  readonly outfile: string
}> {}

export class AuditParseError extends Data.TaggedError("AuditParseError")<{
  readonly outfile: string
  readonly cause: unknown
}> {}

export class AuditAppendError extends Data.TaggedError("AuditAppendError")<{
  readonly outfile: string
  readonly cause: unknown
}> {}

export class AuditSessionError extends Data.TaggedError("AuditSessionError")<{
  readonly cause: unknown
}> {}

export const AuditLine = Schema.Struct({
  seq: Schema.Number,
  tag: Schema.String,
  projectId: Schema.String,
  at: Schema.String
})

export const AuditLineFromJson = Schema.fromJsonString(AuditLine)

export const readAuditCursor = Effect.fn("ClientExample.readAuditCursor")(function*(outfile: string) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(outfile).pipe(
    Effect.mapError((cause) => new AuditParseError({ outfile, cause }))
  )
  if (!exists) return 0
  const info = yield* fs.stat(outfile).pipe(
    Effect.mapError((cause) => new AuditParseError({ outfile, cause }))
  )
  if (info.type !== "File") return 0
  const text = yield* fs.readFileString(outfile).pipe(
    Effect.mapError((cause) => new AuditParseError({ outfile, cause }))
  )
  const lines = text.trim().split("\n").filter(Boolean)
  const decoded = yield* Effect.forEach(lines, (line) =>
    Schema.decodeUnknownEffect(AuditLineFromJson)(line).pipe(
      Effect.mapError((cause) => new AuditParseError({ outfile, cause }))
    ))
  return decoded.reduce((cursor, line) => Math.max(cursor, line.seq), 0)
})

export const runAuditLog = Effect.fn("ClientExample.runAuditLog")((outfile: string) =>
  Effect.scoped(Effect.gen(function*() {
    if (outfile.length === 0 || outfile.startsWith("--")) {
      return yield* new AuditInvalidInputError({ outfile })
    }
    const fs = yield* FileSystem.FileSystem
    const session = yield* ClientSession
    const client = yield* ProjectClient
    const cursor = yield* Ref.make(yield* readAuditCursor(outfile))
    const file = yield* fs.open(outfile, { flag: "a" }).pipe(
      Effect.mapError((cause) => new AuditAppendError({ outfile, cause }))
    )
    const failed = yield* Deferred.make<never, AuditAppendError | AuditParseError | AuditSessionError>()
    const active = yield* Ref.make(Option.none<Fiber.Fiber<void, AuditAppendError | AuditParseError | AuditSessionError>>())
    const interruptActive = Ref.getAndSet(active, Option.none()).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber)
      }))
    )
    yield* Console.log(`audit-log: writing to ${outfile}`)
    const statuses = SubscriptionRef.changes(session.status).pipe(
      Stream.runForEach((status) => Effect.gen(function*() {
        yield* interruptActive
        if (status === "connected") {
          const fromSeq = yield* Ref.get(cursor)
          const fiber = yield* client.events({ fromSeq }).pipe(
            Stream.mapError((cause) => new AuditSessionError({ cause })),
            Stream.runForEach((sequenced) => Ref.get(cursor).pipe(
              Effect.flatMap((lastSeq) => {
                if (sequenced.seq <= lastSeq) return Effect.void
                return Schema.encodeEffect(AuditLineFromJson)({
                  seq: sequenced.seq,
                  tag: sequenced.event._tag,
                  projectId: String(sequenced.event.projectId),
                  at: String(sequenced.event.occurredAt)
                }).pipe(
                  Effect.mapError((cause) => new AuditParseError({ outfile, cause })),
                  Effect.flatMap((line) => file.writeAll(new TextEncoder().encode(`${line}\n`)).pipe(
                    Effect.mapError((cause) => new AuditAppendError({ outfile, cause }))
                  )),
                  Effect.andThen(Ref.set(cursor, sequenced.seq))
                )
              })
            )),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                ? Deferred.failCause(failed, exit.cause).pipe(Effect.asVoid)
                : Effect.void
            ),
            Effect.forkScoped
          )
          yield* Ref.set(active, Option.some(fiber))
        }
      }))
    )
    yield* Effect.raceFirst(statuses, Deferred.await(failed))
  })))

export const auditLogProgram = Effect.scoped(Effect.gen(function*() {
  const args = yield* (yield* Stdio.Stdio).args
  yield* runAuditLog(args[0] ?? "")
})).pipe(
  Effect.provide(clientLayer(adapter).pipe(Layer.provideMerge(NodeServices.layer)))
)

if (import.meta.main) {
  NodeRuntime["runMain"](auditLogProgram)
}
