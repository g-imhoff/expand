import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Queue, Schedule, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { catch as catchEffect } from "effect/Effect"
import { ChildProcess } from "effect/unstable/process"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { runCommand } from "../../../../test/support/effect-process"
import { ProcessServices } from "../process-services"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { ProcessControl } from "@expand/contracts/process-control"
import { Project } from "@expand/contracts/project"
import {
  runProjectSync,
  type ProjectSnapshot,
  type ProjectSyncSink
} from "@expand/contracts/project-sync"
import type { RuntimeAdapter } from "../../adapter"
import { makeNodeAdapter } from "../../adapters/node"
import { ClientLayer } from "../../client-layer"
import { ClientSession } from "../../client-session"
import { ProjectClient } from "../../project/client"

const waitUntil = (predicate: () => boolean, timeout: Duration.Input) =>
  Effect.sync(predicate).pipe(
    Effect.filterOrFail(Boolean, () => "pending" as const),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail("timed out" as const) }),
    Effect.asVoid
  )

const waitForFile = Effect.fn("ProjectSyncIntegration.waitForFile")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.exists(file).pipe(
    Effect.filterOrFail(Boolean, () => "pending" as const),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeout("5 seconds")
  )
})

const endpointPid = Effect.fn("ProjectSyncIntegration.endpointPid")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const endpoint = path.join(directory, "server.json")
  if (!(yield* fs.exists(endpoint))) return undefined
  return yield* fs.readFileString(endpoint).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EndpointFromJson)),
    Effect.map((value) => value.pid),
    catchEffect(() => Effect.void)
  )
})

const awaitProcessDeath = Effect.fn("ProjectSyncIntegration.awaitProcessDeath")(function*(pid: number) {
  const processControl = yield* ProcessControl
  yield* processControl.probe(pid).pipe(
    Effect.filterOrFail((status) => status === "dead", () => "pending" as const),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(`backend ${pid} did not terminate`)
    }),
    Effect.asVoid
  )
})

const stopEndpoint = Effect.fn("ProjectSyncIntegration.stopEndpoint")(function*(
  pid: number,
  waitForDeath: (pid: number) => Effect.Effect<void, unknown, ProcessControl> = awaitProcessDeath
) {
  yield* runCommand("kill", ["-TERM", String(pid)]).pipe(Effect.exit)
  yield* waitForDeath(pid)
})

const awaitEndpointPid = (directory: string) => endpointPid(directory).pipe(
  Effect.filterOrFail((pid): pid is number => typeof pid === "number", () => "pending" as const),
  Effect.retry(Schedule.spaced("10 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(`backend endpoint did not appear in ${directory}`)
  })
)

const awaitReplacementPid = (directory: string, previousPid: number) => endpointPid(directory).pipe(
  Effect.filterOrFail(
    (pid): pid is number => typeof pid === "number" && pid !== previousPid,
    () => "pending" as const
  ),
  Effect.retry(Schedule.spaced("10 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(`replacement backend endpoint did not appear in ${directory}`)
  })
)

type BackendOwnership =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "FirstPending" }
  | { readonly _tag: "Owned"; readonly pid: number }
  | { readonly _tag: "ReplacementPending"; readonly previousPid: number }

const ownBackend = Effect.fn("ProjectSyncIntegration.ownBackend")(function*(directory: string) {
  let ownership: BackendOwnership = { _tag: "Idle" }
  yield* Effect.addFinalizer(() => Effect.gen(function*() {
    const finalOwnership = ownership
    const pid = yield* finalOwnership._tag === "Idle"
      ? Effect.void
      : finalOwnership._tag === "FirstPending"
      ? endpointPid(directory).pipe(Effect.flatMap((pid) => pid === undefined
        ? awaitEndpointPid(directory)
        : Effect.succeed(pid)))
      : finalOwnership._tag === "ReplacementPending"
      ? awaitReplacementPid(directory, finalOwnership.previousPid)
      : endpointPid(directory).pipe(Effect.map((pid) => pid ?? finalOwnership.pid))
    if (pid !== undefined) yield* stopEndpoint(pid)
  }).pipe(Effect.orDie))
  return {
    capture: (pid: number) => {
      ownership = { _tag: "Owned", pid }
    },
    replacementPending: (previousPid: number) => {
      ownership = { _tag: "ReplacementPending", previousPid }
    },
    track: (adapter: RuntimeAdapter): RuntimeAdapter => ({
      ...adapter,
      spawnBackend: (dataDir) => Effect.sync(() => {
        if (ownership._tag === "Idle") ownership = { _tag: "FirstPending" }
      }).pipe(Effect.andThen(adapter.spawnBackend(dataDir)))
    })
  }
})

const makeLayer = Effect.fn("ProjectSyncIntegration.makeLayer")(function*(
  directory: string,
  transformAdapter: (adapter: RuntimeAdapter) => RuntimeAdapter = (adapter) => adapter
) {
  const path = yield* Path.Path
  const adapter = transformAdapter(makeNodeAdapter({
    backendCommand: Effect.succeed(["node", "--import", "tsx", path.resolve("apps/server/main.ts")])
  }))
  return ClientLayer(adapter).pipe(
    Layer.provide(ProcessServices.layer),
    Layer.provide(Layer.succeed(AppContext, makeAppContext(path, {
      homeDir: directory,
      cwd: directory,
      dataDir: directory
    })))
  )
})

describe.sequential("ProjectSync integration", () => {
  it.live("waits for confirmed backend death after signaling teardown", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const directory = yield* makeTempDirectoryScoped("expand-project-sync-signal-")
      const ready = path.join(directory, "ready")
      const signaled = path.join(directory, "signaled")
      const release = path.join(directory, "release")
      const script = [
        "trap 'printf signaled > \"$2\"; while [[ ! -e \"$3\" ]]; do sleep 0.01; done; exit 0' TERM",
        "printf ready > \"$1\"",
        "while :; do sleep 1; done"
      ].join("\n")
      const handle = yield* ChildProcess.make(
        "bash",
        ["-c", script, "project-sync-signal", ready, signaled, release],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
      )
      yield* Effect.addFinalizer(() => fs.writeFileString(release, "release").pipe(Effect.ignore))
      yield* waitForFile(ready)
      const pid = Number(handle.pid)
      const deathWaitStarted = yield* Queue.unbounded<void>()
      const stopFiber = yield* stopEndpoint(
        pid,
        () => Queue.offer(deathWaitStarted, undefined).pipe(
          Effect.andThen(handle.exitCode),
          Effect.asVoid
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* waitForFile(signaled)
      yield* Queue.take(deathWaitStarted).pipe(Effect.timeout("1 second"))
      const alive = yield* processControl.probe(pid)
      expect(alive).toBe("alive")
      yield* fs.writeFileString(release, "release")
      yield* Fiber.join(stopFiber)
      yield* handle.exitCode.pipe(Effect.timeout("5 seconds"))
      const status = yield* processControl.probe(pid)
      expect(status).toBe("dead")
    })).pipe(Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))), 15_000)

  it.live("cleans a backend when acquisition is interrupted before PID capture", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const parentScope = yield* Scope.Scope
      const fixtureScope = yield* Scope.fork(parentScope)
      const backendSpawned = yield* Queue.unbounded<void>()
      const directory = yield* makeTempDirectoryScoped("expand-project-sync-early-").pipe(
        Scope.provide(fixtureScope)
      )
      let observedPid: number | undefined
      yield* Effect.addFinalizer(() => observedPid === undefined
        ? Effect.void
        : stopEndpoint(observedPid).pipe(Effect.orDie))
      const ownership = yield* ownBackend(directory).pipe(Scope.provide(fixtureScope))
      const layer = yield* makeLayer(directory, (adapter) => ownership.track({
        ...adapter,
        spawnBackend: (dataDir) => adapter.spawnBackend(dataDir).pipe(
          Effect.tap(() => Queue.offer(backendSpawned, undefined)),
          Effect.andThen(Effect.never)
        )
      }))
      const acquisition = yield* Layer.build(layer).pipe(
        Scope.provide(fixtureScope),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(backendSpawned)
      observedPid = yield* endpointPid(directory).pipe(
        Effect.filterOrFail((pid): pid is number => typeof pid === "number", () => "pending" as const),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("5 seconds")
      )
      yield* Fiber.interrupt(acquisition)
      yield* Scope.close(fixtureScope, Exit.fail("forced pre-capture interruption"))
      expect(yield* processControl.probe(observedPid)).toBe("dead")
      expect(yield* fs.exists(directory)).toBe(false)
    })).pipe(Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))), 15_000)

  it.live("cleans a replacement when reacquisition is interrupted before PID capture", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const parentScope = yield* Scope.Scope
      const fixtureScope = yield* Scope.fork(parentScope)
      const replacementSpawned = yield* Queue.unbounded<void>()
      let observedReplacementPid: number | undefined
      yield* Effect.addFinalizer(() => observedReplacementPid === undefined
        ? Effect.void
        : stopEndpoint(observedReplacementPid).pipe(Effect.orDie))
      const directory = yield* makeTempDirectoryScoped("expand-project-sync-replacement-").pipe(
        Scope.provide(fixtureScope)
      )
      const endpoint = path.join(directory, "server.json")
      let failNextEndpointRead = false
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (file, options) => file === endpoint && failNextEndpointRead
          ? Effect.sync(() => {
            failNextEndpointRead = false
          }).pipe(Effect.andThen(fs.readFileString(`${endpoint}.forced-missing`, options)))
          : fs.readFileString(file, options)
      })
      const replacementPid = yield* Effect.gen(function*() {
        const ownership = yield* ownBackend(directory).pipe(Scope.provide(fixtureScope))
        const adapter = ownership.track(makeNodeAdapter({
          backendCommand: Effect.succeed([
            "node",
            "--import",
            "tsx",
            path.resolve("apps/server/main.ts")
          ])
        }))
        yield* adapter.spawnBackend(directory)
        const firstPid = yield* awaitEndpointPid(directory)
        ownership.capture(firstPid)
        ownership.replacementPending(firstPid)
        yield* stopEndpoint(firstPid)
        const replacementAcquisition = yield* adapter.spawnBackend(directory).pipe(
          Effect.tap(() => Queue.offer(replacementSpawned, undefined)),
          Effect.andThen(Effect.never),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Queue.take(replacementSpawned)
        const replacementPid = yield* endpointPid(directory).pipe(
          Effect.filterOrFail(
            (pid): pid is number => typeof pid === "number" && pid !== firstPid,
            () => "pending" as const
          ),
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("5 seconds")
        )
        observedReplacementPid = replacementPid
        failNextEndpointRead = true
        yield* Fiber.interrupt(replacementAcquisition)
        yield* Scope.close(fixtureScope, Exit.fail("forced replacement read failure"))
        return replacementPid
      }).pipe(Effect.provideService(FileSystem.FileSystem, observedFs))
      expect(yield* processControl.probe(replacementPid)).toBe("dead")
      expect(yield* fs.exists(directory)).toBe(false)
    })).pipe(Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))), 20_000)

  it.live("folds a mutation from one client into another client's sink", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const parentScope = yield* Scope.Scope
      const fixtureScope = yield* Scope.fork(parentScope)
      const fixture = yield* Effect.gen(function*() {
        const dir = yield* makeTempDirectoryScoped("expand-project-sync-")
        const ownership = yield* ownBackend(dir)
        const layer = yield* makeLayer(dir, ownership.track)
        const contextA = yield* Layer.build(layer)
        const pid = yield* awaitEndpointPid(dir)
        ownership.capture(pid)
        const contextB = yield* Layer.build(layer)
        const clientA = yield* ProjectClient.pipe(Effect.provide(contextA))
        const clientB = yield* ProjectClient.pipe(Effect.provide(contextB))
        const sessionB = yield* ClientSession.pipe(Effect.provide(contextB))
        const snapshots: Array<ProjectSnapshot> = []
        const sink: ProjectSyncSink = {
          snapshot: (snapshot) => Effect.sync(() => {
            snapshots.push(snapshot)
          }),
          status: () => Effect.void
        }
        const source = {
          status: SubscriptionRef.changes(sessionB.status),
          list: () => clientB.list({ includeArchived: true }),
          events: ({ fromSeq }: { readonly fromSeq: number }) => clientB.events({ fromSeq })
        }
        const syncFiber = yield* runProjectSync(source, sink).pipe(Effect.forkScoped)
        yield* waitUntil(() => snapshots.length > 0, "10 seconds")
        expect(pid).toBeTypeOf("number")
        const baseline = snapshots.at(-1)!
        const nextEvent = yield* clientA.events({ fromSeq: baseline.seq }).pipe(
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.forkScoped
        )
        const created = yield* clientA.create({ name: "sync-integration", ensure: false })
        const sequenced = yield* Fiber.join(nextEvent)
        yield* waitUntil(
          () => snapshots.some((snapshot) => snapshot.seq === sequenced.seq),
          "10 seconds"
        )
        const reached = snapshots.find((snapshot) => snapshot.seq === sequenced.seq)!
        expect(reached).toEqual({
          projects: Project.foldList(baseline.projects, sequenced.event),
          seq: sequenced.seq
        })
        expect(reached.projects).toContainEqual(created.project)
        yield* Fiber.interrupt(syncFiber)
        return { dir, pid }
      }).pipe(Scope.provide(fixtureScope))

      expect(yield* processControl.probe(fixture.pid)).toBe("alive")
      yield* Scope.close(fixtureScope, Exit.void)
      expect(yield* processControl.probe(fixture.pid)).toBe("dead")
      expect(yield* fs.exists(fixture.dir)).toBe(false)
    })).pipe(Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))), 30_000)

  it.live("resnapshots after ClientLayer kills and reacquires the backend", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const parentScope = yield* Scope.Scope
      const fixtureScope = yield* Scope.fork(parentScope)
      const fixture = yield* Effect.gen(function*() {
        const dir = yield* makeTempDirectoryScoped("expand-project-sync-")
        const ownership = yield* ownBackend(dir)
        const layer = yield* makeLayer(dir, ownership.track)
        const context = yield* Layer.build(layer)
        const firstOwnedPid = yield* awaitEndpointPid(dir)
        ownership.capture(firstOwnedPid)
        const client = yield* ProjectClient.pipe(Effect.provide(context))
        const session = yield* ClientSession.pipe(Effect.provide(context))
        const snapshots: Array<ProjectSnapshot> = []
        const statuses: Array<string> = []
        const syncFiber = yield* runProjectSync(
          {
            status: SubscriptionRef.changes(session.status),
            list: () => client.list({ includeArchived: true }),
            events: ({ fromSeq }) => client.events({ fromSeq })
          },
          {
            snapshot: (snapshot) => Effect.sync(() => {
              snapshots.push(snapshot)
            }),
            status: (status) => Effect.sync(() => {
              statuses.push(status)
            })
          }
        ).pipe(Effect.forkScoped)
        yield* waitUntil(() => snapshots.length > 0, "10 seconds")
        const before = yield* client.create({ name: "before-backend-kill", ensure: false })
        yield* waitUntil(
          () => snapshots.at(-1)?.projects.some((project) => project.id === before.project.id) === true,
          "10 seconds"
        )
        const firstPid = yield* endpointPid(dir)
        expect(firstPid).toBeTypeOf("number")
        if (firstPid !== undefined) {
          ownership.replacementPending(firstPid)
          yield* runCommand("kill", ["-TERM", String(firstPid)])
        }
        yield* waitUntil(() => statuses.includes("reconnecting"), "10 seconds")
        const finalPid = yield* endpointPid(dir).pipe(
          Effect.filterOrFail(
            (pid): pid is number => typeof pid === "number" && pid !== firstPid,
            () => "pending" as const
          ),
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("20 seconds")
        )
        ownership.capture(finalPid)
        const after = yield* client.create({ name: "after-backend-kill", ensure: false })
        yield* waitUntil(
          () => snapshots.at(-1)?.projects.some((project) => project.id === after.project.id) === true,
          "10 seconds"
        )
        expect(statuses.filter((status) => status === "connected")).toHaveLength(2)
        expect(snapshots.at(-1)?.projects).toEqual(
          expect.arrayContaining([before.project, after.project])
        )
        yield* Fiber.interrupt(syncFiber)
        return { dir, pid: finalPid }
      }).pipe(Scope.provide(fixtureScope))

      expect(yield* processControl.probe(fixture.pid)).toBe("alive")
      yield* Scope.close(fixtureScope, Exit.void)
      expect(yield* processControl.probe(fixture.pid)).toBe("dead")
      expect(yield* fs.exists(fixture.dir)).toBe(false)
    })).pipe(Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))), 60_000)
})
