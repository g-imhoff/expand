import { createServer } from "node:http"
import type { Socket } from "node:net"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, FileSystem, Layer, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NetAddress } from "effect/net"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { describe, expect } from "vitest"
import { makeNodeAdapter } from "../../adapters/node"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { RuntimeAdapter } from "../../adapter"
import { BackendUnavailable } from "../../errors"
import { ClientSession } from "../../client-session"
import {
  RemoteBackendConfig,
  acquireRemoteClient,
  RemoteClientLayer,
  RemoteSessionLayer,
  redactTokenText,
  resolveRemoteEndpoint,
  testRemoteConnection,
  withoutLocalSpawn,
  type RemoteEndpoint
} from "../../remote"

const loopbackToken = "remote-t17-loopback-secret"
const wrongToken = "remote-t17-wrong-token"

const makeHandlers = () =>
  ExpandRpcs.toLayer({
    Health: () => Effect.succeed("ok"),
    ProjectCreate: () => Effect.die("unused"),
    ProjectRename: () => Effect.die("unused"),
    ProjectChangeDirectory: () => Effect.die("unused"),
    ProjectArchive: () => Effect.die("unused"),
    ProjectRestore: () => Effect.die("unused"),
    ProjectSetMetadata: () => Effect.die("unused"),
    ProjectDelete: () => Effect.die("unused"),
    ProjectList: () => Effect.succeed({ projects: [], seq: 0 }),
    Connect: () => Stream.make(true).pipe(Stream.concat(Stream.never)),
    Events: () => Stream.never,
    AutomationRoutineCreate: () => Effect.die("unused"),
    AutomationRoutineEdit: () => Effect.die("unused"),
    AutomationRoutineEnable: () => Effect.die("unused"),
    AutomationRoutinePause: () => Effect.die("unused"),
    AutomationRoutineDelete: () => Effect.die("unused"),
    AutomationRoutineGet: () => Effect.die("unused"),
    AutomationRoutineList: () => Effect.die("unused"),
    AutomationIntegrationPut: () => Effect.die("unused"),
    AutomationIntegrationGet: () => Effect.die("unused"),
    AutomationIntegrationStatus: () => Effect.die("unused"),
    AutomationCredentialPut: () => Effect.die("unused"),
    AutomationCredentialRemove: () => Effect.die("unused"),
    AutomationCredentialList: () => Effect.die("unused"),
    AutomationPreviewClassification: () => Effect.die("unused"),
    AutomationRunList: () => Effect.die("unused"),
    AutomationRunGet: () => Effect.die("unused"),
    AutomationRunMetrics: () => Effect.die("unused"),
    AutomationNotificationList: () => Effect.die("unused"),
    AutomationNotificationMarkRead: () => Effect.die("unused"),
    AutomationCatalog: () => Effect.die("unused")
  })

const guardedTestProtocol = (token: string) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function*() {
      const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
      const router = yield* HttpRouter.HttpRouter
      yield* router.add(
        "GET",
        "/rpc",
        Effect.gen(function*() {
          const params = yield* HttpServerRequest.ParsedSearchParams
          const presented = params.token
          if (typeof presented !== "string" || presented !== token) {
            return HttpServerResponse.empty({ status: 401 })
          }
          return yield* httpEffect
        })
      )
      return protocol
    })
  )

const startLoopbackBackend = Effect.fn("RemoteBackendTest.startLoopbackBackend")(function*() {
  const sockets = new Set<Socket>()
  const server = createServer()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => {
      sockets.delete(socket)
    })
  })
  const rpc = RpcServer.layer(ExpandRpcs).pipe(
    Layer.provide(makeHandlers()),
    Layer.provide(guardedTestProtocol(loopbackToken)),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  const serverLayer = HttpRouter.serve(rpc, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" }))
  )
  const transport = yield* Layer.build(serverLayer)
  const address = yield* HttpServer.HttpServer.pipe(
    Effect.map((server) => server.address),
    Effect.provide(transport)
  )
  const port = NetAddress.isInetAddress(address) ? address.port : 0
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    dropConnections: Effect.sync(() => {
      for (const socket of sockets) socket.destroy()
    })
  }
})

const nodeAdapter = makeNodeAdapter({ backendCommand: Effect.succeed([]) })

const countingAdapter = (spawns: { count: number }): RuntimeAdapter => ({
  protocolLayer: nodeAdapter.protocolLayer,
  spawnBackend: () => Effect.sync(() => {
    spawns.count += 1
  }).pipe(Effect.andThen(Effect.die("local spawn must not run in remote mode")))
})

const remoteEndpoint = (url: string, token: string): Effect.Effect<RemoteEndpoint, BackendUnavailable> =>
  resolveRemoteEndpoint({ url, token })

describe("remote backend", () => {
  it.live("connects to a loopback backend and answers RPCs without spawning locally", () =>
    Effect.scoped(Effect.gen(function*() {
      const backend = yield* startLoopbackBackend()
      const spawns = { count: 0 }
      const endpoint = yield* remoteEndpoint(backend.url, loopbackToken)
      const { client, endpoint: acquired } = yield* acquireRemoteClient(countingAdapter(spawns), endpoint)
      expect(acquired.url).toBe(backend.url)
      expect(yield* client.Health()).toBe("ok")
      expect(yield* client.ProjectList({})).toEqual({ projects: [], seq: 0 })
      expect(spawns.count).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("serves domain clients over a remote session without spawning locally", () =>
    Effect.scoped(Effect.gen(function*() {
      const backend = yield* startLoopbackBackend()
      const spawns = { count: 0 }
      const endpoint = yield* remoteEndpoint(backend.url, loopbackToken)
      const context = yield* Layer.build(RemoteClientLayer(countingAdapter(spawns), endpoint))
      const session = yield* ClientSession.pipe(Effect.provide(context))
      const client = yield* session.current
      expect(yield* client.Health()).toBe("ok")
      expect(yield* SubscriptionRef.get(session.status)).toBe("connected")
      expect(spawns.count).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("reports reconnecting without spawning when the loopback backend drops", () =>
    Effect.scoped(Effect.gen(function*() {
      const parentScope = yield* Scope.Scope
      const serverScope = yield* Scope.fork(parentScope)
      const backend = yield* startLoopbackBackend().pipe(Scope.provide(serverScope))
      const spawns = { count: 0 }
      const endpoint = yield* remoteEndpoint(backend.url, loopbackToken)
      const context = yield* Layer.build(
        RemoteSessionLayer(countingAdapter(spawns), endpoint)
      )
      const session = yield* ClientSession.pipe(Effect.provide(context))
      expect(yield* SubscriptionRef.get(session.status)).toBe("connected")
      yield* backend.dropConnections
      yield* Scope.close(serverScope, Exit.void)
      const reconnecting = yield* SubscriptionRef.changes(session.status).pipe(
        Stream.filter((status) => status === "reconnecting"),
        Stream.take(1),
        Stream.runDrain,
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) })
      )
      expect(reconnecting).toBe(true)
      expect(spawns.count).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("fails an unavailable remote without spawning locally and without leaking the token", () =>
    Effect.scoped(Effect.gen(function*() {
      const spawns = { count: 0 }
      const endpoint = yield* resolveRemoteEndpoint({ host: "127.0.0.1", port: 9, token: loopbackToken })
      const exit = yield* acquireRemoteClient(countingAdapter(spawns), endpoint).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(spawns.count).toBe(0)
      if (Exit.isFailure(exit)) {
        const failures = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
        expect(failures.length).toBeGreaterThan(0)
        for (const failure of failures) {
          expect(failure).toBeInstanceOf(BackendUnavailable)
          expect(String(failure)).not.toContain(loopbackToken)
        }
      }
      const probe = yield* testRemoteConnection(countingAdapter(spawns), endpoint)
      expect(probe).toMatchObject({ reachable: false, authenticated: false })
      expect(probe.detail).not.toContain(loopbackToken)
      expect(spawns.count).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("reports reachable and authenticated for a live backend, and rejects a bad token", () =>
    Effect.scoped(Effect.gen(function*() {
      const backend = yield* startLoopbackBackend()
      const spawns = { count: 0 }
      const adapter = countingAdapter(spawns)
      const good = yield* remoteEndpoint(backend.url, loopbackToken)
      const probe = yield* testRemoteConnection(adapter, good)
      expect(probe).toMatchObject({ reachable: true, authenticated: true })
      expect(probe.detail).not.toContain(loopbackToken)
      const bad = yield* remoteEndpoint(backend.url, wrongToken)
      const rejected = yield* testRemoteConnection(adapter, bad)
      expect(rejected.authenticated).toBe(false)
      expect(rejected.detail).not.toContain(loopbackToken)
      expect(rejected.detail).not.toContain(wrongToken)
      expect(spawns.count).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("resolves host/port and URL targets and redacts tokens everywhere", () =>
    Effect.gen(function*() {
      const fromHostPort = yield* resolveRemoteEndpoint({ host: "127.0.0.1", port: 43111, token: loopbackToken })
      expect(fromHostPort.url).toBe("ws://127.0.0.1:43111/rpc")
      const fromUrl = yield* resolveRemoteEndpoint({ url: "ws://example.internal:8080", token: loopbackToken })
      expect(fromUrl.url).toBe("ws://example.internal:8080/rpc")
      const secure = yield* resolveRemoteEndpoint({ host: "backend.example", port: 8443, secure: true, token: loopbackToken })
      expect(secure.url).toBe("wss://backend.example:8443/rpc")
      const invalidScheme = yield* resolveRemoteEndpoint({ url: "http://example.internal/rpc", token: loopbackToken }).pipe(Effect.flip)
      expect(invalidScheme).toBeInstanceOf(BackendUnavailable)
      expect(String(invalidScheme)).not.toContain(loopbackToken)
      const badPort = yield* resolveRemoteEndpoint({ host: "127.0.0.1", port: 70000, token: loopbackToken }).pipe(Effect.flip)
      expect(badPort).toBeInstanceOf(BackendUnavailable)
      const missingToken = yield* resolveRemoteEndpoint({ host: "127.0.0.1", port: 43111, token: "  " }).pipe(Effect.flip)
      expect(missingToken).toBeInstanceOf(BackendUnavailable)
      expect(redactTokenText(`uses ${loopbackToken} twice: ${loopbackToken}`, fromHostPort.token)).toBe("uses [redacted] twice: [redacted]")
      const config = yield* Schema.decodeUnknownEffect(RemoteBackendConfig)({
        url: "ws://127.0.0.1:43111/rpc",
        token: loopbackToken
      })
      expect(config.url).toBe("ws://127.0.0.1:43111/rpc")
      expect(String(config.token)).toBe("<redacted>")
    }))

  it.effect("refuses to spawn through the remote guard", () =>
    Effect.gen(function*() {
      const guarded = withoutLocalSpawn(nodeAdapter)
      const error = yield* guarded.spawnBackend("/state").pipe(Effect.flip)
      expect(error).toBeInstanceOf(BackendUnavailable)
      expect(error.reason).toBe("remote mode: local backend spawn is disabled")
    }).pipe(Effect.provide(FileSystem.layerNoop({}))))

})
