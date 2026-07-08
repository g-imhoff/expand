// Derived window typing — never hand-write bridge methods here. The single
// source of truth is the ExpandIpc registry (shared/ipc/channels.ts).
import type { IpcBridgeOf } from "@expand/electron-ipc/contract"

type ExpandRegistry = (typeof import("@expand/desktop/shared/ipc/channels"))["ExpandIpc"]

declare global {
  interface Window {
    expand: IpcBridgeOf<ExpandRegistry>
  }
}

export {}
