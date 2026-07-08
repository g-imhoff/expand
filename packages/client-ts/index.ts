export type { RuntimeAdapter } from "@expand/client-ts/adapter"
export { readEndpoint } from "@expand/client-ts/discovery"
export { BackendUnavailable } from "@expand/client-ts/errors"
export { type ExpandRpcClientApi } from "@expand/client-ts/rpc-client"
export { ProjectClient, ProjectClientLayer, type ProjectClientApi } from "@expand/client-ts/project-client"
export { ServerClient, ServerClientLayer, type ServerClientApi } from "@expand/client-ts/server-client"
export { ClientLayer } from "@expand/client-ts/client-layer"
export { withClient } from "@expand/client-ts/with-client"
export { resolveBackendCommand, type ResolveBackendCommandOptions } from "@expand/client-ts/backend-command"
export { ProjectStore, ProjectStoreLayer, type ConnectionStatus, type ProjectStoreApi } from "@expand/client-ts/project-store"
export { supervised } from "@expand/client-ts/supervise"

// Contract vocabulary re-exports
// The public API signatures above are typed in terms of @expand/contracts
// symbols; re-export them here so consumers can name and pattern-match on the
// SDK surface without deep-importing @expand/contracts. Tagged-error and schema
// classes are re-exported as value+type (so they can be caught / matched); pure
// types use `export type`.
import type { RpcClientError as RpcClientErrorNS } from "effect/unstable/rpc"
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
export type RpcClientError = RpcClientErrorNS.RpcClientError
