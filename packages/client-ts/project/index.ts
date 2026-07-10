/**
 * `@expand/client-ts/project` — the project domain of the Expand client SDK.
 *
 * @remarks
 * - **Reactive store** — {@link ProjectStore} / {@link ProjectStoreLayer}: a live,
 *   reconnecting, event-sourced mirror of project state
 *   ({@link ProjectStoreApi.subscribe}, `ProjectStoreApi.projects`) plus command
 *   methods; the primary API for GUI/TUI consumers.
 * - **Typed facade** — {@link ProjectClient}: stateless one-RPC-per-method calls
 *   over the shared connection; the primary API for CLIs and scripts.
 * - **Contract vocabulary** — {@link Project}, result types, and the domain error
 *   tags ({@link ProjectNotFound}, …), re-exported from `@expand/contracts` so
 *   consumers can name and pattern-match the surface without a deep import.
 *
 * Connection-level machinery (`ClientLayer`, adapters, transport errors,
 * `SequencedEvent`) lives at the package root `@expand/client-ts`.
 *
 * @packageDocumentation
 */

// Reactive store
export { ProjectStore, ProjectStoreLayer, type ProjectStoreApi } from "./store"

// Typed facade
export { ProjectClient, ProjectClientLayer, type ProjectClientApi } from "./client"

// Contract vocabulary — re-exported from @expand/contracts so the domain surface
// is nameable without a deep import. Tagged-error / schema classes are value+type.
export { Project, ProjectCreateResult, ProjectDeleteResult } from "@expand/contracts/project"
export {
  ProjectNotFound,
  ProjectAlreadyExists,
  ProjectNameConflict,
  ProjectDirectoryInvalid,
  ProjectDirectoryConflict,
  ProjectInvalidInput
} from "@expand/contracts/rpc"
