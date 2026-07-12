import { Effect } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"

export const dieOnRpcClientError = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError>, R> =>
  effect.pipe(
    Effect.catchIf(isRpcClientError, (e) => Effect.die(e), (e) => Effect.fail(e))
  ) as Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError>, R>

// The proxy forwards to the client-ts store; a transport failure (RpcClientError)
// is an internal defect, never a wire-recoverable error. Refinement form (mirroring
// the server guard) narrows the result error to `Exclude<E, RpcClientError>`;
// `catchTag` cannot narrow over a generic `E` inside this helper.
const isRpcClientError = (e: unknown): e is RpcClientError.RpcClientError =>
  typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "RpcClientError"
