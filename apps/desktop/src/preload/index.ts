import { exposeBridge } from "@yodea/electron-ipc/preload"
import { electronPreloadDeps } from "@yodea/electron-ipc/preload-electron"
import { YodeaIpc } from "@yodea/desktop/shared/ipc/channels"

exposeBridge(YodeaIpc, YodeaIpc.prefix, electronPreloadDeps())
