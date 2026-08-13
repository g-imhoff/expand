// THE Expand IPC registry — the single source of truth for the desktop shell's
// IPC surface (BOUNDARIES.md I-1). Channels here are restricted to desktop-shell
// concerns; ALL domain/backend interaction rides ExpandRpcs over the MessagePort.
// The `event` kind may only carry pre-port bootstrap messages — domain push is
// stream RPCs on the port.
import { IpcChannel, IpcContract } from "@expand/electron-ipc/contract"

/**
 * THE Expand IPC registry — shell concerns only; ALL domain/backend interaction rides
 * ExpandRpcs over the MessagePort. The `event` kind is pre-port bootstrap only.
 */
export const ExpandIpc = IpcContract.make("expand", {
  /** Nonce-correlated MessagePort handoff carrying the ExpandRpcs RPC channel. */
  rpcPort: IpcChannel.portExchange()
})
