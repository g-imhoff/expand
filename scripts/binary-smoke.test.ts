import { NodeServices } from "@effect/platform-node"
import { ProcessControl } from "@expand/contracts/process-control"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, FileSystem, Layer, Path } from "effect"
import { describe, expect } from "vitest"
import { processSpawnerFixture } from "../test/support/process-spawner"
import {
  assessArtifacts,
  assessDeparture,
  assessEndpoint,
  cleanupTransition,
  initialCertificationState,
  parseEvidence,
  parseJobIdentity,
  parseStatus,
  readinessTransition,
  reapTransition,
  releaseTransition
} from "./binary-smoke-model"
import {
  BinarySmokeError,
  JOB_CONTROL_FIXTURE,
  certifyBinaries,
  retainCleanupCause,
  runJobControlFact
} from "./binary-smoke"

const state = () => initialCertificationState("/tmp/expand", 41)

const expectModelError = (operation: () => unknown, reason: string): void => {
  try {
    operation()
    expect.unreachable("expected model failure")
  } catch (error) {
    expect(error).toMatchObject({ reason: expect.stringContaining(reason) })
  }
}

describe("binary certification model", () => {
  it("accepts ownership evidence in the recorded guardian group", () => {
    expect(parseEvidence("73 91\n", 91)).toEqual({ pid: 73, pgid: 91 })
  })

  it("rejects missing ownership evidence", () => {
    expectModelError(() => parseEvidence(undefined, 91), "evidence was not recorded")
  })

  it("rejects malformed ownership evidence", () => {
    expectModelError(() => parseEvidence("malformed", 91), "evidence was malformed")
  })

  it("rejects ownership evidence from a replacement process group", () => {
    expectModelError(() => parseEvidence("73 92", 91), "process group")
  })

  it("captures the exact second shell job", () => {
    expect(parseJobIdentity("[2]+ 44 Running command", 44)).toEqual({ job: "%2", pid: 44 })
  })

  it("rejects the first shell job", () => {
    expectModelError(() => parseJobIdentity("[1]+ 44 Running command", 44), "second job")
  })

  it("rejects a shell job whose PID was replaced", () => {
    expectModelError(() => parseJobIdentity("[2]+ 45 Running command", 44), "PID")
  })

  it("accepts an owned endpoint while the child remains active", () => {
    expect(readinessTransition(state(), { endpointPid: 41, activeBefore: true, activeAfter: true }).phase).toBe("ready")
  })

  it("rejects a readiness race after endpoint acceptance", () => {
    expectModelError(() => readinessTransition(state(), { endpointPid: 41, activeBefore: true, activeAfter: false }), "readiness")
  })

  it("rejects an endpoint PID replacement", () => {
    expectModelError(() => assessEndpoint(state(), 42), "endpoint PID")
  })

  it("accepts a cached nonzero status", () => {
    expect(parseStatus("23\n")).toBe(23)
  })

  it("rejects missing status", () => {
    expectModelError(() => parseStatus(undefined), "status was not recorded")
  })

  it("rejects malformed status", () => {
    expectModelError(() => parseStatus("256"), "status was malformed")
  })

  it("requires backend departure before guardian release", () => {
    expectModelError(() => releaseTransition(state()), "departure")
  })

  it("retires job eligibility before reaping cached status", () => {
    const released = releaseTransition({ ...state(), phase: "departed", job: "%2" })
    expect(reapTransition(released, 23)).toEqual(expect.objectContaining({ phase: "reaped", job: undefined, exitStatus: 23 }))
  })

  it("rejects reaping before release", () => {
    expectModelError(() => reapTransition({ ...state(), phase: "departed" }, 0), "release")
  })

  it("accepts departure only when files and processes are absent", () => {
    expect(assessDeparture(state(), { endpoint: false, endpointLock: false, backendLock: false, processInGroup: false }).phase).toBe("departed")
  })

  it.each(["endpoint", "endpointLock", "backendLock", "processInGroup"] as const)(
    "rejects departure while %s remains",
    (remaining) => {
      expectModelError(() => assessDeparture(state(), {
        endpoint: remaining === "endpoint",
        endpointLock: remaining === "endpointLock",
        backendLock: remaining === "backendLock",
        processInGroup: remaining === "processInGroup"
      }), "cleanup timed out")
    }
  )

  it("rejects residual certification files", () => {
    expectModelError(() => assessArtifacts({ endpoint: false, endpointLock: true, backendLock: false }), "remaining")
  })

  it("escalates bounded cleanup from TERM to KILL", () => {
    const term = cleanupTransition(state(), true)
    expect(term.cleanupSignal).toBe("SIGTERM")
    expect(cleanupTransition(term, true).cleanupSignal).toBe("SIGKILL")
  })

  it("completes cleanup after TERM grace when the job exits", () => {
    expect(cleanupTransition(cleanupTransition(state(), true), false).phase).toBe("cleaned")
  })

  it("retains active-job ownership after bounded KILL failure", () => {
    const killed = cleanupTransition(cleanupTransition({ ...state(), job: "%2" }, true), true)
    expectModelError(() => cleanupTransition(killed, true), "bounded cleanup")
    expect(killed.job).toBe("%2")
    expect(killed.phase).toBe("acquired")
  })
})

describe("binary certification live ownership", () => {
  it.live("runs the exact source-declared job-control fixture and propagates cached nonzero status", () =>
    runJobControlFact(".", ["bash", "-c", "sleep 0.05; exit 23"]).pipe(
      Effect.tap((fact) => Effect.sync(() => {
        expect(JOB_CONTROL_FIXTURE).toBe("scripts/fixtures/job-control.sh")
        expect(fact.job).toBe("%2")
        expect(fact.pid).toBeGreaterThan(0)
        expect(fact.pgid).toBeGreaterThan(0)
        expect(fact.exitStatus).toBe(23)
      })),
      Effect.provide(NodeServices.layer)
    ))

  it.effect("starts the real health CLI under the guardian immediately after the build", () =>
    Effect.gen(function*() {
      const fixture = processSpawnerFixture([0, 1])
      yield* certifyBinaries("/repo").pipe(
        Effect.provide(FileSystem.layerNoop({
          makeTempDirectoryScoped: () => Effect.succeed("/tmp/cert"),
          makeDirectory: () => Effect.void,
          remove: () => Effect.void
        })),
        Effect.provide(Path.layer),
        Effect.provide(Layer.succeed(ProcessControl, {
          currentPid: 1,
          probe: () => Effect.succeed("dead" as const)
        })),
        Effect.provide(fixture.layer),
        Effect.exit
      )
      expect(fixture.records).toHaveLength(2)
      const guardian = fixture.records[1]?.command
      expect(guardian?._tag).toBe("StandardCommand")
      if (guardian?._tag === "StandardCommand") {
        expect(guardian.command).toBe("bash")
        expect(guardian.args).toEqual(expect.arrayContaining([
          JOB_CONTROL_FIXTURE,
          "./dist/expand",
          "--data-dir",
          "/tmp/cert",
          "health"
        ]))
      }
    }))

  it.effect("build is the first child step and interruption releases the active build", () =>
    Effect.gen(function*() {
      const fixture = processSpawnerFixture([], { neverExitAt: 0 })
      const fiber = yield* certifyBinaries("/repo").pipe(
        Effect.provide(FileSystem.layerNoop({ remove: () => Effect.void, makeDirectory: () => Effect.void, chmod: () => Effect.void })),
        Effect.provide(Path.layer),
        Effect.provide(Layer.succeed(ProcessControl, {
          currentPid: 1,
          probe: () => Effect.succeed("dead" as const)
        })),
        Effect.provide(fixture.layer),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(fixture.records[0]?.command._tag).toBe("StandardCommand")
      if (fixture.records[0]?.command._tag === "StandardCommand") {
        expect(fixture.records[0].command.command).toBe("tsx")
        expect(fixture.records[0].command.args).toEqual(["scripts/build.ts"])
      }
      yield* Fiber.interrupt(fiber)
      expect(fixture.records).toHaveLength(1)
      expect(fixture.records[0]?.releaseCount).toBe(1)
    }))

  it.effect("interrupts every acquired child and retains no process owner", () =>
    Effect.gen(function*() {
      const fixture = processSpawnerFixture([], { neverExitAt: 0 })
      const started = yield* Deferred.make<void>()
      const layer = Layer.effectDiscard(Deferred.succeed(started, undefined)).pipe(Layer.provide(fixture.layer))
      const fiber = yield* runJobControlFact("/repo", ["sleep", "30"]).pipe(
        Effect.provide(fixture.layer),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.succeed(started, undefined)
      yield* Fiber.interrupt(fiber)
      expect(layer).toBeDefined()
      expect(fixture.records[0]?.releaseCount).toBe(1)
    }))

  it.effect("retains primary and cleanup failures in the same Cause", () => {
    const primary = new BinarySmokeError({ operation: "command", detail: "primary" })
    const cleanup = new BinarySmokeError({ operation: "cleanup", detail: "kill failed" })
    return retainCleanupCause(Effect.fail(primary), Effect.die(cleanup)).pipe(
      Effect.sandbox,
      Effect.flip,
      Effect.tap((cause) => Effect.sync(() => {
        const errors = cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)
        const defects = cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)
        expect(errors).toEqual([primary])
        expect(defects).toEqual([cleanup])
      }))
    )
  })
})
