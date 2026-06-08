import { Scope } from "effect"
import { buildClient } from "@yodea/desktop/renderer/rpc/client"
import { makeRendererPort } from "@yodea/desktop/renderer/rpc/renderer-port"
import type { RendererRuntime, YodeaClient } from "@yodea/desktop/renderer/rpc/runtime"

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

export const connectClient = async (
  port: MessagePort,
  runtime: RendererRuntime
): Promise<YodeaClient> => {
  const scope = Scope.makeUnsafe()
  return runtime.runPromise(buildClient(makeRendererPort(port)).pipe(Scope.provide(scope)))
}
