import { YodeaRpcs } from "@yodea/contracts/rpc"
import { healthHandlers } from "@yodea/desktop/main/rpc/health-handlers"
import { projectHandlers } from "@yodea/desktop/main/rpc/project-handlers"
import { connectionHandlers } from "@yodea/desktop/main/rpc/connection-handlers"

export const DesktopRpcHandlers = YodeaRpcs.toLayer({
  ...healthHandlers,
  ...projectHandlers,
  ...connectionHandlers
})
