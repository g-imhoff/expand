// Preload interpreter. Pure module: MUST NOT import "electron" (the adapter in
// preload-electron.ts does) and carries no Effect runtime — the preload stays a
// small auditable artifact. One closed-over function per channel; no exposed
// function ever accepts a channel name (Doyensec/Discord RCE lesson).
import type { AnyIpcChannel, IpcContract } from "@yodea/electron-ipc/contract"
import { portGrantName, portRequestName, wireName } from "@yodea/electron-ipc/contract"

export interface PreloadIpcEvent {
  readonly ports: ReadonlyArray<unknown>
}

export interface PreloadIpcDeps {
  readonly send: (channel: string, payload: unknown) => void
  readonly invoke: (channel: string, payload: unknown) => Promise<unknown>
  /** Subscribe; returns the unsubscribe function. */
  readonly on: (channel: string, listener: (event: PreloadIpcEvent, payload: unknown) => void) => () => void
  readonly exposeInMainWorld: (key: string, api: unknown) => void
  /** Relay a message (with transferables) from the preload into the page's main world. */
  readonly postToMainWorld: (message: unknown, transfer: ReadonlyArray<unknown>) => void
}

export const exposeBridge = <C extends IpcContract>(contract: C, apiKey: string, deps: PreloadIpcDeps): void => {
  const api: Record<string, unknown> = {}
  for (const [key, channel] of Object.entries<AnyIpcChannel>(contract.channels)) {
    const name = wireName(contract, key as keyof C["channels"] & string)
    switch (channel._kind) {
      case "send": {
        api[key] = (payload: unknown) => deps.send(name, payload)
        break
      }
      case "invoke": {
        api[key] = (payload: unknown) => deps.invoke(name, payload)
        break
      }
      case "event": {
        api[key] = (listener: (payload: unknown) => void) =>
          // Wrapper strips the IpcRendererEvent: it leaks the raw renderer-side primitive via event.sender.
          deps.on(name, (_event, payload) => listener(payload))
        break
      }
      case "portExchange": {
        // Static grant relay: MessagePorts cannot cross the context bridge (electron#27024),
        // so the port is re-posted into the main world with a nonce-correlated marker.
        deps.on(portGrantName(contract, key), (event, payload) => {
          const nonce =
            typeof payload === "object" && payload !== null
              ? (payload as { readonly nonce?: unknown }).nonce
              : undefined
          if (typeof nonce !== "string") return
          deps.postToMainWorld({ _tag: "IpcPortGrant", channel: name, nonce }, event.ports)
        })
        api[key] = (nonce: string) => deps.send(portRequestName(contract, key), { nonce })
        break
      }
    }
  }
  deps.exposeInMainWorld(apiKey, api)
}
