import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, FileSystem, Layer, Option, Path, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { catch as catchEffect } from "effect/Effect"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { runCommand } from "../../../../test/support/effect-process"
import { ProcessServices } from "../process-services"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { Project } from "@expand/contracts/project"
import {
  runProjectSync,
  type ProjectSnapshot,
  type ProjectSyncSink
} from "@expand/contracts/project-sync"
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

const endpointPid = Effect.fn("ProjectSyncIntegration.endpointPid")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const endpoint = path.join(directory, "server.json")
  if (!(yield* fs.exists(endpoint))) return undefined
  return yield* fs.readFileString(endpoint).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EndpointFromJson)),
    Effect.map((value) => value.pid),
    catchEffect(() => Effect.succeed(undefined))
  )
})

const stopEndpoint = Effect.fn("ProjectSyncIntegration.stopEndpoint")(function*(directory: string) {
  const pid = yield* endpointPid(directory)
  if (pid !== undefined) yield* runCommand("kill", ["-TERM", String(pid)]).pipe(Effect.exit)
})

const makeLayer = Effect.fn("ProjectSyncIntegration.makeLayer")(function*(directory: string) {
  const path = yield* Path.Path
  const adapter = makeNodeAdapter({
    backendCommand: Effect.succeed(["node", "--import", "tsx", path.resolve("apps/server/main.ts")])
  })
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
  it.live("folds a mutation from one client into another client's sink", () =>
    Effect.scoped(Effect.gen(function*() {
      const dir = yield* makeTempDirectoryScoped("expand-project-sync-")
      yield* Effect.addFinalizer(() => stopEndpoint(dir).pipe(Effect.orDie))
      const layer = yield* makeLayer(dir)
      const contextA = yield* Layer.build(layer)
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
    })).pipe(Effect.provide(ProcessServices.layer), Effect.provide(NodeServices.layer)), 30_000)

  it.live("resnapshots after ClientLayer kills and reacquires the backend", () =>
    Effect.scoped(Effect.gen(function*() {
      const dir = yield* makeTempDirectoryScoped("expand-project-sync-")
      yield* Effect.addFinalizer(() => stopEndpoint(dir).pipe(Effect.orDie))
      const layer = yield* makeLayer(dir)
      const context = yield* Layer.build(layer)
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
      if (firstPid !== undefined) yield* runCommand("kill", ["-TERM", String(firstPid)])
      yield* waitUntil(() => statuses.includes("reconnecting"), "10 seconds")
      yield* endpointPid(dir).pipe(
        Effect.filterOrFail((pid) => pid !== undefined && pid !== firstPid, () => "pending" as const),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("20 seconds")
      )
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
    })).pipe(Effect.provide(ProcessServices.layer), Effect.provide(NodeServices.layer)), 60_000)
})
