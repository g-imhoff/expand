// Derived window typing — never hand-write bridge methods here. The single
// source of truth is the YodeaIpc registry (shared/ipc/channels.ts).
import type { IpcBridgeOf } from "@yodea/electron-ipc/contract"

type YodeaRegistry = (typeof import("@yodea/desktop/shared/ipc/channels"))["YodeaIpc"]

declare global {
  interface Window {
    yodea: IpcBridgeOf<YodeaRegistry>
  }
}

export {}
