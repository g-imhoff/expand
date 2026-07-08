import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Deferred, Effect, Exit, Layer, PubSub, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { Project } from "@expand/contracts/project"
import { ProjectStore } from "@expand/client-ts"
import { ProjectStoreLayer } from "@expand/client-ts/project-store"
import { bunAdapter } from "@expand/client-ts/adapters/bun"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-window-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const PROJECT_ID = "00000000-0000-4000-8000-00000000aaaa"
const seed: Project = Schema.decodeUnknownSync(Project)({
  id: PROJECT_ID, name: "v2", directory: null, description: null, tags: [],
  archived: false, createdAt: "t0", updatedAt: "t2"
})

describe.sequential("ProjectStore bootstrap window", () => {
  it("an event in the subscribe→list window is seq-gated: newer applied, stale not re-applied", async () => {
    const program = Effect.gen(function* () {
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
            yield* PubSub.publish(pubsub, { seq: 3, event: ProjectRenamed.make({ projectId: PROJECT_ID, name: "v3", occurredAt: "t3" }) })
            yield* PubSub.publish(pubsub, { seq: 1, event: ProjectRenamed.make({ projectId: PROJECT_ID, name: "v0", occurredAt: "t1" }) })
            return { projects: [seed], seq: 2 }
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
      const address = yield* HttpServer.HttpServer.pipe(
        Effect.map((server) => server.address),
        Effect.provide(transport)
      )
      const port = address._tag === "TcpAddress" ? address.port : 0
      writeFileSync(
        join(dir, "server.json"),
        JSON.stringify({ url: `ws://127.0.0.1:${port}/rpc`, token: "window-test", pid: process.pid, protocolVersion: PROTOCOL_VERSION })
      )

      return yield* Effect.gen(function* () {
        const store = yield* ProjectStore
        yield* SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "v3")),
          Stream.take(1),
          Stream.runDrain
        )
        yield* Effect.sleep("150 millis")
        const final = yield* SubscriptionRef.get(store.projects)
        const snap = yield* store.snapshot
        return { final, snap }
      }).pipe(
        Effect.provide(
          ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer), Layer.provide(makeTestAppContext(dir).layer))
        ),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error("v3 never applied — the bootstrap window lost the event"))
        }),
        Effect.ensuring(Scope.close(serverScope, Exit.void).pipe(Effect.exit))
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const r = await Effect.runPromise(program)
    expect(r.final).toHaveLength(1)
    expect(r.final[0]?.name).toBe("v3")
    expect(r.snap.seq).toBe(3)
  })
})
