// Preload interpreter. Pure module: MUST NOT import "electron" (the adapter in
// preload-electron.ts does) and carries no Effect runtime — the preload stays a
// small auditable artifact. One closed-over function per channel; no exposed
// function ever accepts a channel name (Doyensec/Discord RCE lesson).
import type { AnyIpcChannel, IpcContract } from "@expand/electron-ipc/contract"
import { portGrantName, portRequestName, wireName } from "@expand/electron-ipc/contract"

export interface PreloadIpcEvent<Port = unknown> {
  readonly ports: ReadonlyArray<Port>
}

export interface PreloadIpcDeps<Port = unknown> {
  readonly send: (channel: string, payload: unknown) => void
  readonly invoke: (channel: string, payload: unknown) => Promise<unknown>
  /** Subscribe; returns the unsubscribe function. */
  readonly on: (channel: string, listener: (event: PreloadIpcEvent<Port>, payload: unknown) => void) => () => void
  readonly exposeInMainWorld: (key: string, api: unknown) => void
  /** Relay a message (with transferables) from the preload into the page's main world. */
  readonly postToMainWorld: (message: unknown, transfer: ReadonlyArray<Port>) => void
  readonly onContextDisposed: (dispose: () => void) => () => void
}

export const exposeBridge = <C extends IpcContract, Port = unknown>(
  contract: C,
  apiKey: string,
  deps: PreloadIpcDeps<Port>
): (() => void) => {
  interface OwnedDisposer {
    readonly deactivate: () => void
    readonly release: () => void
  }

  const api: Record<string, unknown> = {}
  const bridgeState = { active: true }
  const owned = new Set<OwnedDisposer>()
  let disposed = false

  const own = (deactivate: () => void, dispose: () => void): (() => void) => {
    let released = false
    const item: OwnedDisposer = {
      deactivate,
      release: () => {
        if (released) return
        released = true
        owned.delete(item)
        deactivate()
        dispose()
      }
    }
    owned.add(item)
    return item.release
  }

  const disposeBridge = () => {
    if (disposed) return
    disposed = true
    bridgeState.active = false
    const snapshot = [...owned].reverse()
    for (const item of snapshot) item.deactivate()
    const causes: Array<unknown> = []
    for (const item of snapshot) {
      try {
        item.release()
      } catch (cause) {
        causes.push(cause)
      }
    }
    if (causes.length === 1) throw causes[0]
    if (causes.length > 1) throw new AggregateError(causes, "preload bridge disposal failed")
  }

  try {
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
          api[key] = (listener: (payload: unknown) => void) => {
            if (!bridgeState.active) return () => {}
            const state = { active: true }
            let unsubscribe: () => void
            try {
              unsubscribe = deps.on(name, (_event, payload) => {
                if (bridgeState.active && state.active) listener(payload)
              })
            } catch (cause) {
              state.active = false
              throw cause
            }
            return own(() => {
              state.active = false
            }, unsubscribe)
          }
          break
        }
        case "portExchange": {
          const state = { active: true }
          let unsubscribe: () => void
          try {
            unsubscribe = deps.on(portGrantName(contract, key), (event, payload) => {
              if (!bridgeState.active || !state.active) return
              const nonce =
                typeof payload === "object" && payload !== null
                  ? (payload as { readonly nonce?: unknown }).nonce
                  : undefined
              if (typeof nonce !== "string") return
              deps.postToMainWorld({ _tag: "IpcPortGrant", channel: name, nonce }, event.ports)
            })
          } catch (cause) {
            state.active = false
            throw cause
          }
          own(() => {
            state.active = false
          }, unsubscribe)
          api[key] = (nonce: string) => deps.send(portRequestName(contract, key), { nonce })
          break
        }
        default: {
          channel satisfies never
          break
        }
      }
    }
    own(() => {}, deps.onContextDisposed(disposeBridge))
    deps.exposeInMainWorld(apiKey, api)
    return disposeBridge
  } catch (cause) {
    try {
      disposeBridge()
    } catch (cleanupCause) {
      const cleanupCauses = cleanupCause instanceof AggregateError ? cleanupCause.errors : [cleanupCause]
      throw new AggregateError([cause, ...cleanupCauses], "preload bridge acquisition failed")
    }
    throw cause
  }
}
