import { Effect, PlatformError, Schema } from "effect"
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError"

export const guard = Effect.fnUntraced(function* guard<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.fn.Return<A, Exclude<E, SqlError | Schema.SchemaError | PlatformError.PlatformError>, R> {
  return yield* effect.pipe(
    Effect.catchIf(isInfra, (e) => Effect.die(e), (e) => Effect.fail(e))
  ) as Effect.Effect<A, Exclude<E, SqlError | Schema.SchemaError | PlatformError.PlatformError>, R>
})

// Infra errors that use-cases surface (their signatures carry `| UseCaseError` =
// SqlError | SchemaError). A SQL failure or a stray decode error is an
// unrecoverable defect, never a recoverable wire error. Refinement form is what
// lets `catchIf` narrow the result error to `Exclude<E, SqlError | SchemaError>`,
// so `toLayer`'s handler-error ⊆ declared-union check is the leak-proof backstop:
// any *other* undeclared error would fail to compile, not silently cross the wire.
const isInfra = (e: unknown): e is SqlError | Schema.SchemaError | PlatformError.PlatformError =>
  isSqlError(e) || Schema.isSchemaError(e) || e instanceof PlatformError.PlatformError
