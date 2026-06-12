// THE Yodea IPC registry — the single source of truth for the desktop shell's
// IPC surface (BOUNDARIES.md I-1). Channels here are restricted to desktop-shell
// concerns; ALL domain/backend interaction rides YodeaRpcs over the MessagePort.
// The `event` kind may only carry pre-port bootstrap messages — domain push is
// stream RPCs on the port.
import { IpcChannel, IpcContract } from "@yodea/electron-ipc/contract"

/**
 * THE Yodea IPC registry — shell concerns only; ALL domain/backend interaction rides
 * YodeaRpcs over the MessagePort. The `event` kind is pre-port bootstrap only.
 */
export const YodeaIpc = IpcContract.make("yodea", {
  /** Nonce-correlated MessagePort handoff carrying the YodeaRpcs RPC channel. */
  rpcPort: IpcChannel.portExchange()
})
