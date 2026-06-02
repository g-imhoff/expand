import { Scope } from "effect"
import { buildClient, type RendererPortLike } from "@yodea/desktop/renderer/rpc/client"
import type { RendererRuntime, YodeaClient } from "@yodea/desktop/renderer/rpc/runtime"

// Ask the preload for a MessagePort and resolve once it arrives. Re-callable on
// reload. DOM (uses window); covered by E2E, not Bun unit tests.
export const awaitPort = (): Promise<MessagePort> =>
  new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data === "yodea:port" && e.ports[0]) {
        window.removeEventListener("message", onMessage)
        const port = e.ports[0]
        resolve(port)
      }
    }
    window.addEventListener("message", onMessage)
    window.yodea.requestPort()
  })

// Build the serialized RPC client over a real MessagePort using the renderer
// runtime. The client's transport (encode-on-send / decode-on-receive) and its
// receive loop are owned by a connection-scoped Scope that we intentionally keep
// open for the connection's lifetime: a renderer connection lives until the
// window reloads (which tears the whole runtime/port down and re-runs awaitPort).
// Keeping the scope open also discharges the `Scope` requirement so the build
// runs on the no-services renderer runtime. port.start() is invoked by the
// protocol once it has installed its onmessage handler.
export const connectClient = async (
  port: MessagePort,
  runtime: RendererRuntime
): Promise<YodeaClient> => {
  const scope = Scope.makeUnsafe()
  // A DOM MessagePort satisfies RendererPortLike structurally; its onmessage
  // event carries .data, which is all the protocol reads.
  return runtime.runPromise(buildClient(port as unknown as RendererPortLike).pipe(Scope.provide(scope)))
}
