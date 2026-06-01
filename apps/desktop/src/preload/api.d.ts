// The renderer's only bridge surface: a request to (re)establish the RPC port.
// Everything else flows through the transferred MessagePort + the typed
// YodeaRpcs contract — no per-feature methods here.
export interface YodeaBridge {
  requestPort: () => void
}

declare global {
  interface Window {
    yodea: YodeaBridge
  }
}
