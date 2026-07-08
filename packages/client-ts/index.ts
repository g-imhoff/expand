// Public API surface for `@expand/client-ts`.
//
// The exports below the first divider are what a typical consumer needs; the
// "Advanced / plumbing" block is for less common cases; the contract-vocabulary
// block re-exports the domain types the API is phrased in terms of. Platform
// adapters live behind the separate `@expand/client-ts/adapters/{bun,node}`
// subpaths. See README.md for a quickstart and ARCHITECTURE.md for internals.

// ─────────────────────────────────────────────────────────────────────────────
// Reactive store — the primary API for GUI/TUI consumers. A live, reconnecting,
// event-sourced mirror of project state (`ProjectStore.subscribe` /
// `ProjectStore.projects`) plus command methods.
// ─────────────────────────────────────────────────────────────────────────────
export { ProjectStore, ProjectStoreLayer, type ProjectStoreApi, type ConnectionStatus } from "@expand/client-ts/project-store"

// ─────────────────────────────────────────────────────────────────────────────
// Composition — build a Layer for a platform adapter, and resolve the command
// used to spawn the backend. Pair with an adapter from `./adapters/*`.
// ─────────────────────────────────────────────────────────────────────────────
export { ClientLayer } from "@expand/client-ts/client-layer"
export { resolveBackendCommand, type ResolveBackendCommandOptions } from "@expand/client-ts/backend-command"

// ─────────────────────────────────────────────────────────────────────────────
// Platform — the adapter seam (type only). Concrete adapters are constructed via
// `makeBunAdapter` / `makeNodeAdapter` from `@expand/client-ts/adapters/{bun,node}`.
// ─────────────────────────────────────────────────────────────────────────────
export type { RuntimeAdapter } from "@expand/client-ts/adapter"

// ─────────────────────────────────────────────────────────────────────────────
// Errors — the transport-level failures the SDK surfaces. Domain errors
// (ProjectNotFound, …) come from the contract-vocabulary block below.
// ─────────────────────────────────────────────────────────────────────────────
import type { RpcClientError as RpcClientErrorNS } from "effect/unstable/rpc"
export { BackendUnavailable } from "@expand/client-ts/errors"
export type RpcClientError = RpcClientErrorNS.RpcClientError

// ─────────────────────────────────────────────────────────────────────────────
// Typed facades — stateless one-RPC-per-method clients over a shared connection,
// plus the one-shot `withClient` escape hatch for ad-hoc calls.
// ─────────────────────────────────────────────────────────────────────────────
export { ProjectClient, ProjectClientLayer, type ProjectClientApi } from "@expand/client-ts/project-client"
export { ServerClient, ServerClientLayer, type ServerClientApi } from "@expand/client-ts/server-client"
export { withClient } from "@expand/client-ts/with-client"

// ─────────────────────────────────────────────────────────────────────────────
// Advanced / plumbing — rarely needed directly.
//   ExpandRpcClientApi — the raw client type `withClient` hands its callback.
//   readEndpoint       — read/validate the backend endpoint descriptor file.
//   supervised         — log-on-crash wrapper for background fibers.
// ─────────────────────────────────────────────────────────────────────────────
export { type ExpandRpcClientApi } from "@expand/client-ts/rpc-client"
export { readEndpoint } from "@expand/client-ts/discovery"
export { supervised } from "@expand/client-ts/supervise"

// ─────────────────────────────────────────────────────────────────────────────
// Contract vocabulary re-exports.
// The public API signatures above are typed in terms of @expand/contracts
// symbols; re-export them here so consumers can name and pattern-match on the
// SDK surface without deep-importing @expand/contracts. Tagged-error and schema
// classes are re-exported as value+type (so they can be caught / matched); pure
// types use `export type`.
// ─────────────────────────────────────────────────────────────────────────────
export { Project, ProjectCreateResult, ProjectDeleteResult } from "@expand/contracts/project"
export {
  ProjectNotFound,
  ProjectAlreadyExists,
  ProjectNameConflict,
  ProjectDirectoryInvalid,
  ProjectDirectoryConflict,
  ProjectInvalidInput
} from "@expand/contracts/rpc"
export { SequencedEvent } from "@expand/contracts/events/domain"
