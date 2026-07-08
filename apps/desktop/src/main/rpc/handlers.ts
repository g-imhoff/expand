import { ExpandRpcs } from "@expand/contracts/rpc"
import { healthHandlers } from "@expand/desktop/main/rpc/health-handlers"
import { projectHandlers } from "@expand/desktop/main/rpc/project-handlers"
import { connectionHandlers } from "@expand/desktop/main/rpc/connection-handlers"

export const DesktopRpcHandlers = ExpandRpcs.toLayer({
  ...healthHandlers,
  ...projectHandlers,
  ...connectionHandlers
})
