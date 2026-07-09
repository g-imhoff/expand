import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Deferred, Effect, Exit, Fiber, Layer, PubSub, Scope, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectCreated } from "@expand/contracts/events/project"
import { Project } from "@expand/contracts/project"
import { ProjectStore } from "../../project-store"
import { ProjectStoreLayer } from "../../project-store"
import { bunAdapter } from "../../adapters/bun"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-snap-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const N = 40
const idFor = (i: number): string =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
const nameFor = (i: number): string => `p${i}`

// All seq>=1 events the server will publish, in order.
const allEvents: ReadonlyArray<SequencedEvent> = Array.from({ length: N }, (_, k) => {
  const i = k + 1
  return {
    seq: i,
    event: ProjectCreated.make({ projectId: idFor(i), name: nameFor(i), occurredAt: `t${i}` })
  }
})

// fold of every event with seq <= upTo, starting from the bootstrap snapshot (empty, seq 0)
const expectedNamesUpTo = (upTo: number): ReadonlyArray<string> => {
  let acc: ReadonlyArray<Project> = []
  for (const se of allEvents) {
    if (se.seq <= upTo) acc = Project.foldList(acc, se.event)
  }
  return acc.map((p) => p.name)
}

const makeServer = (
  publishEvents: (pubsub: PubSub.PubSub<SequencedEvent>) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<SequencedEvent>()
    const subscribed = yield* Deferred.make<void>()

    const handlers = ExpandRpcs.toLayer({
      Health: () => Effect.succeed("ok"),
      ProjectCreate: () => Effect.die("unused"),
      ProjectRename: () => Effect.die("unused"),
      ProjectChangeDirectory: () => Effect.die("unused"),
      ProjectArchive: () => Effect.die("unused"),
      ProjectRestore: () => Effect.die("unused"),
      ProjectSetMetadata: () => Effect.die("unused"),
      ProjectDelete: () => Effect.die("unused"),
      ProjectList: () =>
        Effect.gen(function* () {
          yield* Deferred.await(subscribed)
          // bootstrap is empty at seq 0; events flow afterwards (driven from the server scope).
          return { projects: [] as ReadonlyArray<Project>, seq: 0 }
        }),
      Connect: () => Stream.make(true).pipe(Stream.concat(Stream.never)),
      Events: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const sub = yield* PubSub.subscribe(pubsub)
            yield* Deferred.succeed(subscribed, undefined)
            return Stream.fromSubscription(sub)
          })
        )
    })

    const rpc = RpcServer.layer(ExpandRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerNdjson)
    )
    const bun = BunHttpServer.layer({ port: 0, gracefulShutdownTimeout: "500 millis" })
    const serverLayer = Layer.mergeAll(HttpRouter.serve(rpc, { disableLogger: true }), bun).pipe(Layer.provide(bun))
    const serverScope = yield* Scope.make()
    const transport = yield* Layer.build(serverLayer).pipe(Scope.provide(serverScope))
    // Drive events from the long-lived server scope (not a per-RPC handler scope),
    // gated until the client's Events subscription has registered.
    yield* Effect.forkIn(
      Deferred.await(subscribed).pipe(Effect.flatMap(() => publishEvents(pubsub))),
      serverScope
    )
    const address = yield* HttpServer.HttpServer.pipe(
      Effect.map((server) => server.address),
      Effect.provide(transport)
    )
    const port = address._tag === "TcpAddress" ? address.port : 0
    writeFileSync(
      join(dir, "server.json"),
      JSON.stringify({ url: `ws://127.0.0.1:${port}/rpc`, token: "snap-test", pid: process.pid, protocolVersion: PROTOCOL_VERSION })
    )
    return serverScope
  })

describe.sequential("ProjectStore snapshot consistency (C2)", () => {
  it("every concurrently-observed snapshot has projects === fold(events with seq <= snapshot.seq)", async () => {
    const program = Effect.gen(function* () {
      // Deliver events slowly (a tick between each) so the read loop repeatedly
      // samples the tiny inter-write window of every event N.
      const serverScope = yield* makeServer((pubsub) =>
        Effect.forEach(
          allEvents,
          (se) => PubSub.publish(pubsub, se).pipe(Effect.flatMap(() => Effect.sleep("3 millis"))),
          { discard: true }
        )
      )

      return yield* Effect.gen(function* () {
        const store = yield* ProjectStore
        const flag = { converged: false }
        // Watcher: flip the flag once the projects ref has reached N entries.
        yield* Effect.forkChild(
          SubscriptionRef.changes(store.projects).pipe(
            Stream.filter((ps) => ps.length === N),
            Stream.take(1),
            Stream.runDrain,
            Effect.flatMap(() => Effect.sync(() => { flag.converged = true }))
          )
        )
        // Sample snapshot in a tight loop (the Effect scheduler round-robins it against
        // the session loop, so reads land in the session loop's inter-write window — the
        // C2 race). A HARD iteration cap guarantees termination regardless of scheduling;
        // we then explicitly wait for full convergence. Every read is recorded.
        const reads: Array<{ projects: ReadonlyArray<Project>; seq: number }> = []
        const maxReads = 200000
        let count = 0
        yield* Effect.whileLoop({
          while: () => !flag.converged && count < maxReads,
          body: () => store.snapshot,
          step: (snap) => { count++; reads.push(snap) }
        })
        // ensure full convergence even if the read cap was hit first
        if (!flag.converged) {
          yield* SubscriptionRef.changes(store.projects).pipe(
            Stream.filter((ps) => ps.length === N),
            Stream.take(1),
            Stream.runDrain
          )
        }
        const finalSnap = yield* store.snapshot
        return { reads, finalSnap }
      }).pipe(
        Effect.provide(ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer), Layer.provide(makeTestAppContext(dir).layer))),
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(new Error("events never fully converged"))
        }),
        Effect.ensuring(Scope.close(serverScope, Exit.void).pipe(Effect.exit))
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const { reads, finalSnap } = await Effect.runPromise(program)

    // The invariant: for EVERY observed snapshot, projects deep-equals fold(events <= seq).
    for (const snap of reads) {
      const names = snap.projects.map((p) => p.name).sort()
      const expected = [...expectedNamesUpTo(snap.seq)].sort()
      expect(names).toEqual(expected)
    }
    expect(finalSnap.seq).toBe(N)
    expect(finalSnap.projects.map((p) => p.name).sort()).toEqual([...expectedNamesUpTo(N)].sort())
  })

  it("a duplicate/old event (seq <= state.seq) does not change projects and is not published to the hub", async () => {
    const program = Effect.gen(function* () {
      const e1: SequencedEvent = { seq: 1, event: ProjectCreated.make({ projectId: idFor(1), name: nameFor(1), occurredAt: "t1" }) }
      const e2: SequencedEvent = { seq: 2, event: ProjectCreated.make({ projectId: idFor(2), name: nameFor(2), occurredAt: "t2" }) }
      // a stale duplicate of seq 1 (would create p99 if wrongly applied)
      const stale: SequencedEvent = { seq: 1, event: ProjectCreated.make({ projectId: idFor(99), name: nameFor(99), occurredAt: "tstale" }) }
      const e3: SequencedEvent = { seq: 3, event: ProjectCreated.make({ projectId: idFor(3), name: nameFor(3), occurredAt: "t3" }) }
      // Released by the test once it has applied e2 and is watching the hub.
      const releaseStale = yield* Deferred.make<void>()

      const serverScope = yield* makeServer((pubsub) =>
        Effect.forEach([e1, e2], (se) => PubSub.publish(pubsub, se), { discard: true }).pipe(
          Effect.flatMap(() => Deferred.await(releaseStale)),
          // After the stale dup, publish e3 (a fresh seq) as a "tracer": the hub
          // observer waits for e3, proving the stale dup did not slip through ahead of it.
          Effect.flatMap(() => Effect.forEach([stale, e3], (se) => PubSub.publish(pubsub, se), { discard: true }))
        )
      )

      return yield* Effect.gen(function* () {
        const store = yield* ProjectStore
        // Wait until e2 has been applied.
        yield* SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "p2")),
          Stream.take(1),
          Stream.runDrain
        )
        // Subscribe to the hub, then release the stale dup + tracer e3.
        const hubFiber = yield* Effect.forkChild(
          store.events.pipe(
            Stream.takeUntil((se) => se.seq === 3),
            Stream.runCollect
          )
        )
        yield* Effect.sleep("50 millis") // let the hub subscription register
        yield* Deferred.succeed(releaseStale, undefined)
        // Wait for the tracer (seq 3) to be applied.
        yield* SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "p3")),
          Stream.take(1),
          Stream.runDrain
        )
        const hubExit = yield* Fiber.await(hubFiber)
        const snap = yield* store.snapshot
        const hubEvents = Exit.isSuccess(hubExit) ? Array.from(hubExit.value) : []
        return { snap, hubSeqs: hubEvents.map((se) => se.seq) }
      }).pipe(
        Effect.provide(ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer), Layer.provide(makeTestAppContext(dir).layer))),
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(new Error("tracer e3 never applied"))
        }),
        Effect.ensuring(Scope.close(serverScope, Exit.void).pipe(Effect.exit))
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const { snap, hubSeqs } = await Effect.runPromise(program)
    // stale seq-1 event must NOT have created p99
    expect(snap.projects.some((p) => p.name === "p99")).toBe(false)
    expect(snap.projects.map((p) => p.name).sort()).toEqual(["p1", "p2", "p3"])
    expect(snap.seq).toBe(3)
    // The hub observed (from after e2) only the tracer e3 — the stale seq-1 dup was
    // never published, so it is absent between e2 and e3.
    expect(hubSeqs).toEqual([3])
  })

  it("the public projects mirror eventually equals the canonical projects after events", async () => {
    const program = Effect.gen(function* () {
      const serverScope = yield* makeServer((pubsub) =>
        Effect.forEach(allEvents, (se) => PubSub.publish(pubsub, se), { discard: true })
      )

      return yield* Effect.gen(function* () {
        const store = yield* ProjectStore
        const mirror = yield* SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.length === N),
          Stream.take(1),
          Stream.runCollect
        )
        const snap = yield* store.snapshot
        return { mirror: Array.from(mirror), snap }
      }).pipe(
        Effect.provide(ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer), Layer.provide(makeTestAppContext(dir).layer))),
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(new Error("mirror never reached N"))
        }),
        Effect.ensuring(Scope.close(serverScope, Exit.void).pipe(Effect.exit))
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const { mirror, snap } = await Effect.runPromise(program)
    const last = mirror[mirror.length - 1] ?? []
    expect(last.map((p) => p.name).sort()).toEqual(snap.projects.map((p) => p.name).sort())
    expect(last.length).toBe(N)
  })
})
