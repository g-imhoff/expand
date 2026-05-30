// Runtime-agnostic core. Adapters are imported explicitly from their own paths
// (@yodea/client-core/adapters/bun | /node) so a Node build never pulls the Bun
// adapter (which imports @effect/platform-bun) and vice-versa.
export type { RuntimeAdapter } from "@yodea/client-core/adapter"
export { findOrSpawnBackend, deleteEndpoint, readEndpoint, BackendUnavailable } from "@yodea/client-core/discovery"
export { withClient, type YodeaClient } from "@yodea/client-core/with-client"
// The ProjectStore export resolves once Task 2.1 lands (project-store.ts).
// export { ProjectStore } from "@yodea/client-core/project-store"
