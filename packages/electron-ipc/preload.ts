import { contextBridge, ipcRenderer } from "electron"
import type { IpcContract } from "./contract"
import type { AnyChannel } from "./internal/contract"
import { grantWire, requestWire, wire } from "./internal/contract"

export const exposeElectronBridge = <C extends IpcContract>(contract: C): void => {
  let active = true
  const disposers: Array<() => void> = []
  const api: Record<string, unknown> = {}
  const stop = () => {
    if (!active) return
    active = false
    const failures: unknown[] = []
    for (const dispose of disposers.splice(0)) try { dispose() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, "bridge cleanup failed")
  }
  try { for (const [key, channel] of Object.entries<AnyChannel>(contract.channels)) {
    const name = wire(contract, key)
    if (channel._kind === "send") api[key] = (payload: unknown) => { if (active) ipcRenderer.send(name, payload) }
    else if (channel._kind === "invoke") api[key] = (payload: unknown) => active ? ipcRenderer.invoke(name, payload) : Promise.reject(new Error("bridge unloaded"))
    else if (channel._kind === "event") api[key] = (listener: (payload: unknown) => void) => {
      if (!active) return () => {}
      let subscribed = true
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => { if (active && subscribed) listener(payload) }
      const dispose = () => { if (!subscribed) return; subscribed = false; ipcRenderer.removeListener(name, wrapped) }
      disposers.push(dispose)
      ipcRenderer.on(name, wrapped)
      return dispose
    }
    else {
      api[key] = (nonce: string) => { if (active) ipcRenderer.send(requestWire(contract, key), { nonce }) }
      const wrapped = (event: Electron.IpcRendererEvent, payload: unknown) => {
        if (!active || !isNoncePayload(payload)) return
        window.postMessage({ _tag: "IpcPortGrant", channel: name, nonce: payload.nonce }, window.location.origin === "null" ? "*" : window.location.origin, event.ports)
      }
      const dispose = () => ipcRenderer.removeListener(grantWire(contract, key), wrapped)
      disposers.push(dispose)
      ipcRenderer.on(grantWire(contract, key), wrapped)
    }
  }
  const unloadDispose = () => window.removeEventListener("unload", stop)
  disposers.push(unloadDispose)
  window.addEventListener("unload", stop, { once: true })
  contextBridge.exposeInMainWorld(contract.prefix, api)
  } catch (error) {
    try { stop() } catch (cleanup) {
      const cleanupErrors = cleanup instanceof AggregateError ? cleanup.errors : [cleanup]
      throw new AggregateError([error, ...cleanupErrors], "bridge acquisition failed")
    }
    throw error
  }
}

const isNoncePayload = (value: unknown): value is { readonly nonce: string } => {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 1 || keys[0] !== "nonce") return false
  const descriptor = Object.getOwnPropertyDescriptor(value, "nonce")
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
}
