import { it } from "@effect/vitest"
import {
  Crypto,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Scope
} from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, expectTypeOf } from "vitest"
import { RpcClient } from "effect/unstable/rpc"
import { AppContext, makeAppContext, type AppContextShape } from "@expand/contracts/app-context"
import { type Endpoint } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import {
  ProcessControl,
  ProcessProbeError,
  type ProcessControlShape
} from "@expand/contracts/process-control"
import type { RuntimeAdapter } from "../../adapter"
import { makeNodeAdapter } from "../../adapters/node"
import { ClientLayer } from "../../client-layer"
import { ClientSession, ClientSessionLayer } from "../../client-session"
import { readEndpoint } from "../../discovery"
import { BackendUnavailable, type EndpointDiscoveryError, type SpawnLockError } from "../../errors"
import { ProjectClient, ProjectClientLayer } from "../../project/client"
import { acquireClient, type ExpandRpcClientApi } from "../../rpc-client"
import { ServerClient, ServerClientLayer } from "../../server/client"
import { findOrSpawnBackend } from "../../spawn"
import { acquireSpawnLock, type SpawnLockLease } from "../../spawn-lock"
import { withClient } from "../../with-client"
import { ProcessServices } from "../process-services"

describe("process control integration", () => {
  it.effect("treats an inaccessible endpoint owner as alive", () =>
    withFixture((context) =>
      writeEndpoint(context, 103).pipe(
        Effect.andThen(readEndpoint),
        Effect.provideService(AppContext, context),
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("inaccessible"))),
        Effect.tap((endpoint) => Effect.sync(() => expect(Option.isSome(endpoint)).toBe(true)))
      )
    ))

  it.effect("does not turn an unknown probe failure into a stale endpoint", () =>
    withFixture((context) => {
      const cause = new TypeError("unknown process probe result")
      const error = new ProcessProbeError({ pid: 104, cause })
      return writeEndpoint(context, 104).pipe(
        Effect.andThen(readEndpoint),
        Effect.provideService(AppContext, context),
        Effect.provideService(ProcessControl, processControl(() => Effect.fail(error))),
        Effect.flip,
        Effect.tap((actual) => Effect.sync(() => expect(actual).toBe(error)))
      )
    }))

  it.effect("probes the endpoint owner pid", () =>
    withFixture((context) => {
      const probed: Array<number> = []
      return writeEndpoint(context, 105).pipe(
        Effect.andThen(readEndpoint),
        Effect.provideService(AppContext, context),
        Effect.provideService(ProcessControl, processControl((pid) =>
          Effect.sync(() => {
            probed.push(pid)
            return "alive"
          })
        )),
        Effect.tap(() => Effect.sync(() => expect(probed).toEqual([105])))
      )
    }))

  it.effect("fails immediately when a process probe fails during polling", () =>
    withFixture((context) => {
      const cause = new TypeError("unknown polling probe failure")
      const error = new ProcessProbeError({ pid: 207, cause })
      return Effect.gen(function*() {
        const probeCalled = yield* Queue.unbounded<void>()
        const completed = yield* Queue.unbounded<unknown>()
        const adapter: RuntimeAdapter = {
          protocolLayer: () => Layer.empty as Layer.Layer<RpcClient.Protocol>,
          spawnBackend: () => writeEndpoint(context, 207).pipe(Effect.orDie)
        }
        const finder = findOrSpawnBackend(adapter).pipe(
          Effect.provideService(AppContext, context),
          Effect.provideService(ProcessControl, processControl(() =>
            Queue.offer(probeCalled, undefined).pipe(
              Effect.andThen(Effect.fail(error))
            )
          ))
        )
        yield* finder.pipe(
          Effect.result,
          Effect.flatMap((result) => Queue.offer(completed, result)),
          Effect.forkChild
        )
        yield* Queue.take(probeCalled)
        const result = yield* Queue.take(completed)
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProcessProbeError", pid: 207, cause }
        })
      }).pipe(Effect.provide(TestClock.layer()))
    }))

  it.effect("maps a process probe failure once at the acquisition boundary", () =>
    withFixture((context) => {
      const cause = new TypeError("unknown acquisition probe failure")
      const probeError = new ProcessProbeError({ pid: 301, cause })
      let protocolCalls = 0
      const adapter: RuntimeAdapter = {
        protocolLayer: () => {
          protocolCalls += 1
          return Layer.empty as Layer.Layer<RpcClient.Protocol>
        },
        spawnBackend: () => Effect.die("unused")
      }
      return writeEndpoint(context, 301).pipe(
        Effect.andThen(acquireClient(adapter)),
        Effect.provideService(AppContext, context),
        Effect.provideService(ProcessControl, processControl(() => Effect.fail(probeError))),
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => {
          expect(error).toBeInstanceOf(BackendUnavailable)
          expect(error).toMatchObject({
            _tag: "BackendUnavailable",
            reason: expect.stringContaining("process probe failed for pid 301")
          })
          expect(protocolCalls).toBe(0)
        }))
      )
    }))

  it.effect("does not expose rejected endpoint tokens in acquisition failures", () =>
    withFixture((context) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const attempted = yield* Queue.unbounded<void>()
      const tokens = ["secret-generation-a", "secret-generation-b", "secret-generation-c"]
      let generation = 0
      const advertise = (index: number) => fs.writeFileString(
        context.paths.endpointFile,
        JSON.stringify({
          url: `ws://127.0.0.1:${51797 + index}/rpc`,
          token: tokens[index],
          pid: 100,
          protocolVersion: PROTOCOL_VERSION
        })
      )
      yield* advertise(generation)
      const adapter: RuntimeAdapter = {
        protocolLayer: () => Layer.succeed(RpcClient.Protocol, {
          run: () => Effect.never,
          send: () => Queue.offer(attempted, undefined).pipe(Effect.asVoid),
          supportsAck: false,
          supportsTransferables: false
        }),
        spawnBackend: () => Effect.sync(() => {
          generation += 1
          return generation
        }).pipe(
          Effect.flatMap(advertise),
          Effect.orDie
        )
      }
      const fiber = yield* acquireClient(adapter).pipe(
        Effect.provideService(AppContext, context),
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("alive"))),
        Effect.exit,
        Effect.forkChild
      )
      for (const _token of tokens) {
        yield* Queue.take(attempted)
        yield* TestClock.adjust("3 seconds")
      }
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const serialized = Schema.encodeSync(Schema.UnknownFromJsonString)(exit)
      for (const token of tokens) expect(serialized).not.toContain(token)
    }).pipe(Effect.provide(TestClock.layer()))))

  it("exposes explicit host requirements and public boundary errors", () => {
    const nodeAdapter = makeNodeAdapter({ backendCommand: Effect.succeed([]) })
    expectTypeOf(acquireSpawnLock("/state/backend.lock")).toEqualTypeOf<
      Effect.Effect<
        SpawnLockLease | undefined,
        SpawnLockError,
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl
      >
    >()
    expectTypeOf(readEndpoint).toEqualTypeOf<
      Effect.Effect<
        Option.Option<Endpoint>,
        ProcessProbeError | EndpointDiscoveryError,
        FileSystem.FileSystem | AppContext | ProcessControl
      >
    >()
    expectTypeOf(findOrSpawnBackend(nodeAdapter)).toEqualTypeOf<
      Effect.Effect<
        Endpoint,
        BackendUnavailable | ProcessProbeError | "pending",
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
      >
    >()
    expectTypeOf(acquireClient(nodeAdapter)).toEqualTypeOf<
      Effect.Effect<
        { readonly client: ExpandRpcClientApi; readonly endpoint: Endpoint },
        BackendUnavailable,
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope | AppContext | ProcessControl
      >
    >()
    const use = (_client: ExpandRpcClientApi): Effect.Effect<42, "use-failure", ProjectClient> =>
      Effect.succeed(42)
    expectTypeOf(withClient(nodeAdapter, use)).toEqualTypeOf<
      Effect.Effect<
        42,
        BackendUnavailable | "use-failure",
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl | ProjectClient
      >
    >()
    expectTypeOf(ClientSessionLayer(nodeAdapter)).toEqualTypeOf<
      Layer.Layer<
        ClientSession,
        BackendUnavailable,
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
      >
    >()
    expectTypeOf(ClientLayer(nodeAdapter)).toEqualTypeOf<
      Layer.Layer<
        ClientSession | ProjectClient | ServerClient,
        BackendUnavailable,
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
      >
    >()
    expectTypeOf(ProjectClientLayer(nodeAdapter)).toEqualTypeOf<
      Layer.Layer<
        ProjectClient,
        BackendUnavailable,
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
      >
    >()
    expectTypeOf(ServerClientLayer(nodeAdapter)).toEqualTypeOf<
      Layer.Layer<
        ServerClient,
        BackendUnavailable,
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
      >
    >()
  })
})

const withFixture = <A, E, R>(
  use: (context: AppContextShape) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-process-control-" })
    return yield* use(makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir }))
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessServices.platformLayer)
  )

const writeEndpoint = (context: AppContextShape, pid: number) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(
      context.paths.endpointFile,
      `{"url":"ws://127.0.0.1:51797/rpc","token":"probe-failure","pid":${pid},"protocolVersion":${PROTOCOL_VERSION}}`
    ))
  )

const processControl = (
  probe: ProcessControlShape["probe"]
): ProcessControlShape => ({ currentPid: 100, probe })
