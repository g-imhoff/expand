import { exposeElectronBridge } from "@expand/electron-ipc/preload"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

exposeElectronBridge(ExpandIpc)
