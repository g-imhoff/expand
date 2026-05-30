// Runtime-agnostic core. Adapters are imported explicitly from their own paths
// (@yodea/client-core/adapters/bun | /node) so a Node build never pulls the Bun
// adapter (which imports @effect/platform-bun) and vice-versa.
export type { RuntimeAdapter } from "@yodea/client-core/adapter"
// The exports below resolve once Tasks 1.2–1.3 + 2.1 land. They are commented
// here so this interface-only task typechecks; Task 1.3 Step 4 / Task 2.1
// restore them as each module is created.
// export { findOrSpawnBackend, deleteEndpoint, readEndpoint, BackendUnavailable } from "@yodea/client-core/discovery"
// export { withClient, type YodeaClient } from "@yodea/client-core/with-client"
// export { ProjectStore } from "@yodea/client-core/project-store"
