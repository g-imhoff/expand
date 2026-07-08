import { exposeBridge } from "@expand/electron-ipc/preload"
import { electronPreloadDeps } from "@expand/electron-ipc/preload-electron"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

exposeBridge(ExpandIpc, ExpandIpc.prefix, electronPreloadDeps())
