import { readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect"
import { ProjectRenamed } from "@expand/contracts/events/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ClientSession, type ClientSessionApi, type ConnectionStatus } from "@expand/client-ts"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { runAuditLog } from "../audit-log"
import { makeDataDir, makeFixtureDir, runExample, spawnExample } from "./helpers"

/** Parse the audit JSONL, tolerating an absent/partial file mid-write. */
const auditLines = (outfile: string): ReadonlyArray<{ readonly seq?: number; readonly tag?: string }> =>
  existsSync(outfile)
    ? readFileSync(outfile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []

const endpointPid = (dataDir: string): number | undefined => {
  const endpoint = join(dataDir, "server.json")
  if (!existsSync(endpoint)) return undefined
  try {
    return (JSON.parse(readFileSync(endpoint, "utf8")) as { readonly pid?: number }).pid
  } catch {
    return undefined
  }
}

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
const pollUntil = async (predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe("example: audit-log", () => {
  it("reopens Events from the last cursor on a newly connected session epoch", async () => {
    const dataDir = makeDataDir()
    const outfile = join(dataDir, "audit.jsonl")
    const status = await Effect.runPromise(SubscriptionRef.make<ConnectionStatus>("connected"))
    const eventRequests: number[] = []
    let closedEpochs = 0
    const event = (seq: number): SequencedEvent => ({
      seq,
      event: ProjectRenamed.make({
        projectId: "00000000-0000-4000-8000-000000000001",
        name: `name-${seq}`,
        occurredAt: `t${seq}`
      })
    })
    const session: ClientSessionApi = {
      status,
      current: Effect.die("unused"),
      epochs: Stream.empty
    }
    const client = {
      events: ({ fromSeq = 0 } = {}) => {
        eventRequests.push(fromSeq)
        return Stream.make(event(eventRequests.length)).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(Effect.sync(() => { closedEpochs += 1 }))
        )
      }
    } as unknown as ProjectClientApi
    const fiber = Effect.runFork(
      runAuditLog(outfile).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ClientSession, session),
          Layer.succeed(ProjectClient, client)
        ))
      )
    )
    try {
      expect(await pollUntil(() => auditLines(outfile).some((line) => line.seq === 1), 1_000)).toBe(true)
      await Effect.runPromise(SubscriptionRef.set(status, "reconnecting"))
      expect(await pollUntil(() => closedEpochs === 1, 1_000)).toBe(true)
      await Effect.runPromise(SubscriptionRef.set(status, "connected"))
      expect(await pollUntil(() => auditLines(outfile).some((line) => line.seq === 2), 1_000)).toBe(true)
      expect(eventRequests).toEqual([0, 1])
      expect(auditLines(outfile).map((line) => line.seq)).toEqual([1, 2])
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("appends a JSONL line for each project change", async () => {
    const dataDir = makeDataDir()
    const outfile = join(dataDir, "audit.jsonl")
    const scan = makeFixtureDir(["audited"])
    // Start the long-running audit-log in the background against the shared data dir.
    const audit = spawnExample("audit-log.ts", [outfile], dataDir)
    try {
      await audit.waitForLine("audit-log: writing to", 30_000)
      // Cause a change on the same backend: bootstrap a project from a throwaway fixture.
      const boot = await runExample("bootstrap-projects.ts", [scan], dataDir) // creates project "audited"
      expect(boot.code, boot.stderr).toBe(0)
      // Poll the outfile for the event instead of a flat sleep.
      const seen = await pollUntil(() => auditLines(outfile).some((e) => e.tag === "ProjectCreated"), 5_000)
      expect(seen, "expected a ProjectCreated line in the audit log").toBe(true)
    } finally {
      await audit.kill()
      rmSync(scan, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 45_000)

  it("continues from the last sequence after the backend reconnects", async () => {
    const dataDir = makeDataDir()
    const outfile = join(dataDir, "audit.jsonl")
    const before = makeFixtureDir(["before-reconnect"])
    const after = makeFixtureDir(["after-reconnect"])
    const audit = spawnExample("audit-log.ts", [outfile], dataDir)
    try {
      await audit.waitForLine("audit-log: writing to", 30_000)
      const first = await runExample("bootstrap-projects.ts", [before], dataDir)
      expect(first.code, first.stderr).toBe(0)
      expect(await pollUntil(() => auditLines(outfile).some((e) => e.seq === 1), 5_000)).toBe(true)
      const firstPid = endpointPid(dataDir)
      expect(firstPid).toBeTypeOf("number")
      process.kill(firstPid!, "SIGTERM")
      const reconnected = await pollUntil(() => {
        const pid = endpointPid(dataDir)
        return pid !== undefined && pid !== firstPid
      }, 15_000)
      expect(reconnected, "expected the audit session to reacquire a backend").toBe(true)
      const second = await runExample("bootstrap-projects.ts", [after], dataDir)
      expect(second.code, second.stderr).toBe(0)
      const continued = await pollUntil(() => auditLines(outfile).some((e) => e.seq === 2), 5_000)
      expect(continued, "expected sequence 2 after reconnect").toBe(true)
      expect(auditLines(outfile).map((e) => e.seq)).toEqual([1, 2])
    } finally {
      await audit.kill()
      rmSync(before, { recursive: true, force: true })
      rmSync(after, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
