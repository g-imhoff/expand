import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import {
  ClientSession,
  type ClientSessionApi,
  type ConnectionStatus
} from "@expand/client-ts"
import {
  ProjectClient,
  type ProjectClientApi
} from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { connectPort } from "@expand/desktop/main/rpc/transport"

const makePort = () => {
  const sent: Array<unknown> = []
  let handler: ((e: { data: unknown }) => void) | undefined
  let started = false
  return {
    port: {
      postMessage: (message: unknown) => sent.push(message),
      on: (_event: "message", callback: (e: { data: unknown }) => void) => { handler = callback },
      start: () => { started = true }
    },
    sent,
    inject: (data: unknown) => handler?.({ data }),
    isStarted: () => started,
    hasHandler: () => handler !== undefined
  }
}

const fakeClientLayer = () => {
  const status = Effect.runSync(SubscriptionRef.make<ConnectionStatus>("connected"))
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  const project: ProjectClientApi = {
    create: () => Effect.die("unused"),
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    events: () => Stream.die("unused")
  }
  return Layer.mergeAll(
    Layer.succeed(ClientSession, session),
    Layer.succeed(ProjectClient, project),
    Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
  )
}

describe("connectPort", () => {
  it("wires the port (start + message handler) and returns a working teardown", async () => {
    const runtime = ManagedRuntime.make(fakeClientLayer())
    const port = makePort()
    try {
      const teardown = connectPort({ port: port.port, runtime })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(port.isStarted()).toBe(true)
      expect(port.hasHandler()).toBe(true)
      expect(typeof teardown).toBe("function")
      await teardown()
    } finally {
      await runtime.dispose()
    }
  })
})
