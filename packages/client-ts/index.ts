/**
 * `@expand/client-ts` — the connection core of the Expand client SDK: discover or
 * spawn the local backend, hold one RPC-over-WebSocket session, and compose the
 * domain services over it.
 *
 * @remarks
 * The root entrypoint is **strictly connection-level** — domain surfaces live on
 * scoped subpaths, with exactly one canonical import path per symbol:
 *
 * - `@expand/client-ts/project` — the session-backed `ProjectClient` facade and
 *   the project contract vocabulary.
 * - `@expand/client-ts/server` — the server domain: the `ServerClient`
 *   health/presence facade.
 * - `@expand/client-ts/adapters/{bun,node}` — the platform seams
 *   (`makeBunAdapter` / `makeNodeAdapter`).
 *
 * What lives here (in export order below):
 *
 * - **Composition** — {@link ClientLayer}, {@link ClientSessionLayer}, and
 *   {@link resolveBackendCommand}.
 * - **Connection state** — {@link ClientSession} and {@link ConnectionStatus}.
 * - **Escape hatch** — {@link withClient}: a one-shot RPC call without a standing
 *   layer.
 * - **Platform** — {@link RuntimeAdapter}: the adapter seam (type only).
 * - **Errors** — {@link BackendUnavailable} / {@link RpcClientError}: transport-level
 *   failures. Domain errors (`ProjectNotFound`, …) come from the domain subpaths.
 * - **Plumbing** — {@link ExpandRpcClientApi} / {@link readEndpoint}: rarely needed
 *   directly.
 * - **Stream vocabulary** — {@link SequencedEvent}: the `{seq, event}` envelope
 *   every domain event stream emits.
 *
 * See `README.md` for a quickstart and `ARCHITECTURE.md` for internals.
 *
 * @packageDocumentation
 */

import type { RpcClientError as RpcClientErrorNS } from "effect/unstable/rpc"

// Composition
export { ClientLayer } from "./client-layer"
export { resolveBackendCommand, type ResolveBackendCommandOptions } from "./backend-command"

export {
  ClientSession,
  ClientSessionLayer,
  type ClientSessionApi,
  type ConnectionStatus
} from "./client-session"

// Escape hatch
export { withClient } from "./with-client"

// Platform (adapter seam — type only)
export type { RuntimeAdapter } from "./adapter"

// Errors (transport-level; domain errors live on the domain subpaths)
export { BackendUnavailable } from "./errors"
export type RpcClientError = RpcClientErrorNS.RpcClientError

// Advanced / plumbing — rarely needed directly
export { type ExpandRpcClientApi } from "./rpc-client"
export { readEndpoint } from "./discovery"

// Stream vocabulary — the envelope every domain event stream emits
export { SequencedEvent } from "@expand/contracts/events/domain"
