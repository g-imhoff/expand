/**
 * `@expand/client-ts/project` — the project domain of the Expand client SDK.
 *
 * @remarks
 * - **Typed facade** — {@link ProjectClient}: one-RPC-per-method calls over the
 *   shared client session.
 * - **Contract vocabulary** — {@link Project}, result types, and the domain error
 *   tags ({@link ProjectNotFound}, …), re-exported from `@expand/contracts` so
 *   consumers can name and pattern-match the surface without a deep import.
 *
 * Connection-level machinery (`ClientLayer`, adapters, transport errors,
 * `SequencedEvent`) lives at the package root `@expand/client-ts`.
 *
 * @packageDocumentation
 */

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
