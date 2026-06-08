export interface RendererPortLike {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
  start(): void
}

export const makeRendererPort = (port: MessagePort): RendererPortLike => ({
  postMessage: (message) => port.postMessage(message),
  get onmessage() {
    return port.onmessage as RendererPortLike["onmessage"]
  },
  set onmessage(handler) {
    port.onmessage = handler
  },
  start: () => port.start()
})
