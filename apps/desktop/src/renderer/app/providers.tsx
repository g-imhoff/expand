import { type ReactNode, useEffect, useMemo, useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Effect, Stream } from "effect"
import { makeRendererRuntime, RpcContext, type YodeaClient } from "@yodea/desktop/renderer/rpc/runtime"
import { awaitPort, connectClient } from "@yodea/desktop/renderer/rpc/port"
import { applyEventToCache } from "@yodea/desktop/renderer/features/projects/cache"

export const Providers = ({ children }: { children: ReactNode }) => {
  const queryClient = useMemo(() => new QueryClient(), [])
  const runtime = useMemo(() => makeRendererRuntime(), [])
  const [client, setClient] = useState<YodeaClient | null>(null)

  useEffect(() => {
    let live = true
    awaitPort()
      .then((port) => connectClient(port, runtime))
      .then((c) => {
        if (!live) return
        setClient(c)
        // One root subscription: fold every live event into the query cache.
        runtime.runFork(
          Stream.runForEach(c.Events(), (event) =>
            Effect.sync(() => applyEventToCache(queryClient, event))
          ).pipe(Effect.scoped)
        )
      })
    return () => {
      live = false
      // Disposing the runtime interrupts the forked Events subscription fiber.
      void runtime.dispose()
    }
  }, [runtime, queryClient])

  if (!client) return <div style={{ fontFamily: "system-ui", padding: 24 }}>Connecting…</div>
  return (
    <QueryClientProvider client={queryClient}>
      <RpcContext.Provider value={{ runtime, client }}>{children}</RpcContext.Provider>
    </QueryClientProvider>
  )
}
