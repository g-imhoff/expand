import { NodeServices } from "@effect/platform-node"
import { layer as effectLayer } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { expect } from "vitest"
import { ProcessServices } from "../process-services"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { readEndpoint } from "../../discovery"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import {
  ProcessControl,
  type ProcessControlShape,
  type ProcessIdentity
} from "@expand/contracts/process-control"

class TestDirectory extends Context.Service<TestDirectory, string>()("expand/DiscoveryTest/Directory") {}

const TestDirectoryLive = Layer.effect(
  TestDirectory,
  makeTempDirectoryScoped("expand-disc-")
).pipe(Layer.provide(NodeServices.layer))

const TestLayer = Layer.mergeAll(
  TestDirectoryLive,
  ProcessServices.discoveryLayer,
  NodeServices.layer
)

effectLayer(TestLayer, { excludeTestServices: true })("readEndpoint", (it) => {
  const appContext = (name: string) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(yield* TestDirectory, name)
    yield* fs.makeDirectory(dir, { recursive: true })
    return makeTestAppContext(dir, dir, path)
  })

  const run = <A, E>(
    name: string,
    effect: Effect.Effect<A, E, FileSystem.FileSystem | AppContext | import("@expand/contracts/process-control").ProcessControl>
  ) => Effect.gen(function*() {
    return yield* effect.pipe(
      Effect.provideService(AppContext, yield* appContext(name))
    )
  })

  const writeEndpoint = (name: string, pid: number, protocolVersion = PROTOCOL_VERSION) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const context = yield* appContext(name)
      const endpoint = yield* Schema.encodeEffect(EndpointFromJson)({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid,
        protocolVersion
      })
      yield* fs.writeFileString(context.paths.endpointFile, endpoint)
    })

  const writeIdentifiedEndpoint = (name: string, pid: number, incarnation: string) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const context = yield* appContext(name)
      const endpoint = yield* Schema.encodeEffect(EndpointFromJson)({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid,
        protocolVersion: PROTOCOL_VERSION,
        incarnation
      })
      yield* fs.writeFileString(context.paths.endpointFile, endpoint)
    })

  const identifiedControl = (observed: ProcessIdentity): ProcessControlShape => ({
    currentPid: 100,
    probe: () => Effect.succeed(observed.status === "dead" ? "dead" : "alive"),
    currentIdentity: () => Effect.sync((): undefined => undefined),
    identify: () => Effect.succeed(observed)
  })

  const runIdentified = (name: string, observed: ProcessIdentity) =>
    run(name, readEndpoint).pipe(
      Effect.provideService(ProcessControl, identifiedControl(observed))
    )

  it.effect("returns None when the file is missing", () =>
    run("missing", readEndpoint).pipe(
      Effect.tap((result) => Effect.sync(() => expect(Option.isNone(result)).toBe(true)))
    ))

  it.effect("returns Some for a live pid", () =>
    Effect.gen(function*() {
      yield* writeEndpoint("live", ProcessServices.alivePid)
      expect(Option.isSome(yield* run("live", readEndpoint))).toBe(true)
    }))

  it.effect("returns None for a dead pid (stale file)", () =>
    Effect.gen(function*() {
      yield* writeEndpoint("dead", 2_147_483_647)
      expect(Option.isNone(yield* run("dead", readEndpoint))).toBe(true)
    }))

  it.effect("returns Some for a live pid with a matching incarnation", () =>
    Effect.gen(function*() {
      yield* writeIdentifiedEndpoint("incarnation-match", ProcessServices.alivePid, "boot:111")
      const result = yield* runIdentified("incarnation-match", { status: "alive", identity: "boot:111" })
      expect(Option.isSome(result)).toBe(true)
    }))

  it.effect("returns None for a live pid with a reused pid incarnation", () =>
    Effect.gen(function*() {
      yield* writeIdentifiedEndpoint("incarnation-reused", ProcessServices.alivePid, "boot:111")
      const result = yield* runIdentified("incarnation-reused", { status: "alive", identity: "boot:222" })
      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("returns None when a recorded incarnation cannot be observed", () =>
    Effect.gen(function*() {
      yield* writeIdentifiedEndpoint("incarnation-unobserved", ProcessServices.alivePid, "boot:111")
      const result = yield* runIdentified("incarnation-unobserved", { status: "alive", identity: undefined })
      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("returns None for an inaccessible owner with a recorded incarnation", () =>
    Effect.gen(function*() {
      yield* writeIdentifiedEndpoint("incarnation-inaccessible", ProcessServices.alivePid, "boot:111")
      const result = yield* runIdentified("incarnation-inaccessible", { status: "inaccessible", identity: undefined })
      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("returns None for a protocol-version mismatch", () =>
    Effect.gen(function*() {
      yield* writeEndpoint("mismatch", ProcessServices.alivePid, PROTOCOL_VERSION + 1)
      expect(Option.isNone(yield* run("mismatch", readEndpoint))).toBe(true)
    }))

  it.effect("returns None for malformed JSON", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const context = yield* appContext("malformed")
      yield* fs.writeFileString(context.paths.endpointFile, "{ not json")
      expect(Option.isNone(yield* run("malformed", readEndpoint))).toBe(true)
    }))

  it.effect("resolves a relative AppContext root from the supplied current directory", () =>
    Path.Path.pipe(
      Effect.tap((path) => Effect.sync(() =>
        expect(makeTestAppContext("state", "/work", path).paths.dataDir).toBe(path.resolve("/work", "state"))
      ))
    ))
})

const makeTestAppContext = (dataDir: string, cwd: string, path: Path.Path) =>
  makeAppContext(path, { homeDir: cwd, cwd, dataDir })
