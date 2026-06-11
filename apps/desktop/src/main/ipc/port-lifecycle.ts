// Reload hardening (spec §8): a renderer reload must interrupt the old port
// fiber — stale stream fibers + request-id collisions hang all new requests.
export interface PortLifecycleDeps {
  readonly onNavigation: (cb: (details: { readonly isSameDocument: boolean }) => void) => void
  readonly onClosed: (cb: () => void) => void
  readonly teardownPort: () => void
  readonly unbind: () => void
}

export const wirePortLifecycle = ({ onNavigation, onClosed, teardownPort, unbind }: PortLifecycleDeps): void => {
  onNavigation((details) => {
    if (!details.isSameDocument) teardownPort()
  })
  onClosed(() => {
    unbind()
    teardownPort()
  })
}
