import { Effect, Scope } from "effect"
import { buildClient } from "@yodea/desktop/renderer/rpc/client"
import type { RendererRuntime, YodeaClient } from "@yodea/desktop/renderer/rpc/runtime"

// Ask the preload for a MessagePort and resolve once it arrives. Re-callable on
// reload. DOM (uses window); covered by E2E, not Bun unit tests.
export const awaitPort = (): Promise<MessagePort> =>
  new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data === "yodea:port" && e.ports[0]) {
        window.removeEventListener("message", onMessage)
        const port = e.ports[0]
        port.start()
        resolve(port)
      }
    }
    window.addEventListener("message", onMessage)
    window.yodea.requestPort()
  })

// Build the client over a real MessagePort using the renderer runtime: outbound
// goes to port.postMessage; inbound is pumped into the client's write.
export const connectClient = async (
  port: MessagePort,
  runtime: RendererRuntime
): Promise<YodeaClient> => {
  // buildClient (makeNoSerialization) is a scoped resource: its scope owns the
  // client's pending-request bookkeeping and must stay open for the connection's
  // lifetime, so it cannot be closed by an `Effect.scoped` that ends at build
  // time. A renderer connection lives until the window reloads (which tears the
  // whole runtime/port down and re-runs awaitPort), so we provide a connection-
  // scoped Scope and intentionally keep it open. This also discharges the
  // `Scope` requirement so the build runs on the no-services renderer runtime.
  const scope = Scope.makeUnsafe()
  const { client, write } = await runtime.runPromise(
    buildClient((message) => Effect.sync(() => port.postMessage(message))).pipe(
      Scope.provide(scope)
    )
  )
  // Pump inbound server messages from the port into the client's write. The
  // precise cast uses write's own parameter type (FromServer<Rpcs>) — no `as any`.
  port.onmessage = (e) => {
    runtime.runFork(write(e.data as Parameters<typeof write>[0]))
  }
  return client
}
