import { Layer } from "effect"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { automationHandlers } from "@expand/desktop/main/rpc/automation-handlers"
import { healthHandlers } from "@expand/desktop/main/rpc/health-handlers"
import { projectHandlers } from "@expand/desktop/main/rpc/project-handlers"
import { connectionHandlers } from "@expand/desktop/main/rpc/connection-handlers"
import {
  backendConnectionHandlers,
  BackendConnectionStore,
  makeBackendConnectionStore
} from "@expand/desktop/main/rpc/backend-connection-handlers"

export const DesktopRpcHandlers = ExpandRpcs.toLayer({
  ...healthHandlers,
  ...projectHandlers,
  ...connectionHandlers,
  ...automationHandlers,
  ...backendConnectionHandlers
}).pipe(
  Layer.provide(Layer.effect(BackendConnectionStore, makeBackendConnectionStore()))
)
