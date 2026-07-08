/**
 * `@expand/client-ts` — the client SDK for the Expand backend: discover or spawn the
 * local backend, hold one RPC-over-WebSocket session, and mirror project state in a
 * live, reconnecting store.
 *
 * @remarks
 * The public surface is organized in tiers (in export order below):
 *
 * - **Reactive store** — {@link ProjectStore} / {@link ProjectStoreLayer}: the primary
 *   API for GUI/TUI consumers. A live, reconnecting, event-sourced mirror of project
 *   state ({@link ProjectStoreApi.subscribe}, `ProjectStoreApi.projects`) plus command
 *   methods.
 * - **Composition** — {@link ClientLayer} / {@link resolveBackendCommand}: build a
 *   `Layer` for a platform adapter, and resolve the command used to spawn the backend.
 * - **Typed facades** — {@link ProjectClient} / {@link ServerClient} / {@link withClient}:
 *   stateless one-RPC-per-method clients over a shared connection, plus a one-shot
 *   escape hatch for ad-hoc calls.
 * - **Errors** — {@link BackendUnavailable} / {@link RpcClientError}: transport-level
 *   failures. Domain errors ({@link ProjectNotFound}, …) come from the contract
 *   vocabulary re-exported below.
 * - **Platform** — {@link RuntimeAdapter}: the adapter seam (type only). Concrete
 *   adapters are constructed via `makeBunAdapter` / `makeNodeAdapter` from the separate
 *   `@expand/client-ts/adapters/{bun,node}` subpaths.
 *
 * The API signatures are phrased in terms of `@expand/contracts` symbols, which are
 * re-exported here so consumers can name and pattern-match on the surface without
 * deep-importing `@expand/contracts`.
 *
 * See `README.md` for a quickstart and `ARCHITECTURE.md` for internals.
 *
 * @packageDocumentation
 */

import type { RpcClientError as RpcClientErrorNS } from "effect/unstable/rpc"

// Reactive store
export { ProjectStore, ProjectStoreLayer, type ProjectStoreApi, type ConnectionStatus } from "./project-store"

// Composition
export { ClientLayer } from "./client-layer"
export { resolveBackendCommand, type ResolveBackendCommandOptions } from "./backend-command"

// Typed facades
export { ProjectClient, ProjectClientLayer, type ProjectClientApi } from "./project-client"
export { ServerClient, ServerClientLayer, type ServerClientApi } from "./server-client"
export { withClient } from "./with-client"

// Platform (adapter seam — type only)
export type { RuntimeAdapter } from "./adapter"

// Errors (transport-level; domain errors come from the contract vocabulary below)
export { BackendUnavailable } from "./errors"
export type RpcClientError = RpcClientErrorNS.RpcClientError

// Advanced / plumbing — rarely needed directly
export { type ExpandRpcClientApi } from "./rpc-client"
export { readEndpoint } from "./discovery"

// Contract vocabulary — re-exported from @expand/contracts so the SDK surface is
// nameable without a deep import. Tagged-error / schema classes are value+type.
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
