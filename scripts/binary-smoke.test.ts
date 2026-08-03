import { NodeServices } from "@effect/platform-node"
import { ProcessControl } from "@expand/contracts/process-control"
import { ProcessServices } from "@expand/server/runtime/node-process-control"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Ref, Schedule, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
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
  releaseTransition,
  timeoutTransition
} from "./binary-smoke-model"
import {
  acknowledgeGuardianOwnership,
  BinarySmokeError,
  JOB_CONTROL_FIXTURE,
  certifyBinaries,
  jobControlCommand,
  cleanupDirectServer,
  cleanupGuardianOwnership,
  certifyCompiledVersion,
  parseProcessGroupRows,
  reserveGuardianRelease,
  retainCleanupCause,
  runBinaryOwnershipCore,
  runCommand,
  runJobControlCommand,
  runJobControlFact,
  runOwnedCli
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

  it("selects only exact PGID rows from the complete process table", () => {
    expect(parseProcessGroupRows("  2 0\n  41 9\n  42 91\n  43 910\n", 91)).toEqual([42])
  })

  it("fails closed on a malformed complete process table row", () => {
    try {
      parseProcessGroupRows("41 91\nmalformed\n", 91)
      expect.unreachable("expected malformed process table failure")
    } catch (error) {
      expect(error).toMatchObject({ operation: "parse", detail: "process table row was malformed" })
    }
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

  it.each([
    ["endpoint-readiness", "endpoint readiness timed out"],
    ["backend-departure", "auto-spawned backend cleanup timed out"],
    ["guardian-reap", "guardian reap timed out"],
    ["direct-server-exit", "direct server exit timed out"]
  ] as const)("models the %s timeout without coordinator policy", (timeout, reason) => {
    expectModelError(() => timeoutTransition(timeout), reason)
  })
})

describe("binary certification live ownership", () => {
  it.effect.each([
    "expand v0.0.0-dev\n",
    "expand v0.0.0-dev+0123456789ab\n"
  ])("accepts compiled development identity %j", (stdout) => {
    const fixture = processSpawnerFixture([0], { stdout: [stdout] })
    return certifyCompiledVersion("/repo").pipe(
      Effect.provide(fixture.layer),
      Effect.tap(() => Effect.sync(() => {
        expect(fixture.records[0]?.command._tag).toBe("StandardCommand")
        if (fixture.records[0]?.command._tag === "StandardCommand") {
          expect(fixture.records[0].command.command).toBe("./dist/expand")
          expect(fixture.records[0].command.args).toEqual(["--version"])
        }
      }))
    )
  })

  it.effect("rejects a compiled identity that does not match the development build", () => {
    const fixture = processSpawnerFixture([0], { stdout: ["1.2.3\n"] })
    return certifyCompiledVersion("/repo").pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({
        operation: "parse",
        detail: expect.stringContaining("compiled version")
      }))
    )
  })

  it.effect.each([
    ...(["guardian-spawn", "stopped-evidence", "endpoint-publication", "lock-observation", "release", "reap"] as const).map((phase) => [phase, "failure"] as const),
    ...(["guardian-spawn", "stopped-evidence", "endpoint-publication", "lock-observation", "release", "reap"] as const).map((phase) => [phase, "interruption"] as const)
  ])(
    "cleans production-core ownership when %s ends in %s",
    ([failedPhase, mode]) => Effect.gen(function*() {
      const events: Array<string> = []
      const guardian = { pid: 40 }
      let guardianAlive = false
      let groupAlive = false
      let artifacts = false
      let releases = 0
      let reaps = 0
      const primary = new BinarySmokeError({ operation: "command", detail: failedPhase })
      const releaseOnce = Effect.sync(() => {
        if (releases === 0) releases += 1
        guardianAlive = false
      })
      const reapOnce = Effect.sync(() => {
        if (reaps === 0) reaps += 1
      })
      const phase = <A>(name: typeof failedPhase, value: A) => Effect.sync(() => {
        events.push(name)
        if (name === "guardian-spawn" && name !== failedPhase) {
          guardianAlive = true
          groupAlive = true
        }
        if (name === "endpoint-publication" || name === "lock-observation") artifacts = true
      }).pipe(
        Effect.andThen(name === "release" ? releaseOnce : name === "reap" ? reapOnce : Effect.void),
        Effect.andThen(name !== failedPhase
          ? Effect.succeed(value)
          : mode === "failure" ? Effect.fail(primary) : Effect.interrupt)
      )
      const exit = yield* runBinaryOwnershipCore({
        guardianSpawn: phase("guardian-spawn", guardian),
        stoppedEvidence: (owned) => Effect.sync(() => expect(owned).toBe(guardian)).pipe(
          Effect.andThen(phase("stopped-evidence", { job: "%2", pid: 41, pgid: 91 }))
        ),
        endpointPublication: (owned, evidence) => Effect.sync(() => {
          expect(owned).toBe(guardian)
          return evidence
        }).pipe(Effect.andThen(phase("endpoint-publication", evidence))),
        lockObservation: (owned, endpoint) => Effect.sync(() => {
          expect(owned).toBe(guardian)
          return endpoint
        }).pipe(Effect.andThen(phase("lock-observation", endpoint))),
        release: (owned, locks) => Effect.sync(() => {
          expect(owned).toBe(guardian)
          return locks
        }).pipe(Effect.andThen(phase("release", locks))),
        reap: (owned) => Effect.sync(() => expect(owned).toBe(guardian)).pipe(
          Effect.andThen(phase("reap", undefined))
        ),
        cleanup: (owned) => Effect.sync(() => expect(owned).toBe(guardian)).pipe(
          Effect.andThen(cleanupGuardianOwnership({
            evidence: failedPhase === "stopped-evidence" ? undefined : { job: "%2", pid: 41, pgid: 91 },
            signalGroup: (signal) => Effect.sync(() => {
              events.push(signal)
              groupAlive = false
              artifacts = false
            }),
            freezeGuardian: Effect.sync(() => events.push("guardian:SIGSTOP")),
            discoverStartupGroup: Effect.succeed(Option.some(91)),
            groupAlive: () => Effect.sync(() => groupAlive),
            signalGuardian: (signal) => Effect.sync(() => {
              events.push(`guardian:${signal}`)
              guardianAlive = false
              artifacts = false
            }),
            guardianRunning: Effect.sync(() => guardianAlive),
            releaseGuardian: releaseOnce,
            reapGuardian: reapOnce,
            artifactsRemain: Effect.sync(() => artifacts),
            wait: Effect.void
          }))
        )
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(guardianAlive).toBe(false)
      expect(groupAlive).toBe(false)
      expect(artifacts).toBe(false)
      expect(releases).toBe(failedPhase === "guardian-spawn" || failedPhase === "stopped-evidence" ? 0 : 1)
      expect(reaps).toBe(failedPhase === "guardian-spawn" ? 0 : 1)
      expect(events).toContain("guardian-spawn")
    }),
    30_000
  )

  it.effect("retains production-core primary and cleanup failures in one Cause", () =>
    Effect.gen(function*() {
      const guardian = { pid: 40 }
      const primary = new BinarySmokeError({ operation: "parse", detail: "primary evidence failure" })
      const cleanup = new BinarySmokeError({ operation: "cleanup", detail: "cleanup verification failure" })
      let cleanupCalls = 0
      const exit = yield* runBinaryOwnershipCore({
        guardianSpawn: Effect.succeed(guardian),
        stoppedEvidence: (owned) => Effect.sync(() => expect(owned).toBe(guardian)).pipe(Effect.andThen(Effect.fail(primary))),
        endpointPublication: () => Effect.die("unreachable"),
        lockObservation: () => Effect.die("unreachable"),
        release: () => Effect.die("unreachable"),
        reap: () => Effect.die("unreachable"),
        cleanup: (owned) => Effect.sync(() => {
          expect(owned).toBe(guardian)
          cleanupCalls += 1
        }).pipe(Effect.andThen(Effect.die(cleanup)))
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(exit.cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)).toContain(primary)
      expect(exit.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)).toContain(cleanup)
      expect(cleanupCalls).toBe(1)
    }))

  it.effect("rolls back an interrupted release reservation and retries CONT", () =>
    Effect.gen(function*() {
      const reservation = yield* Ref.make(false)
      let deliveries = 0
      yield* reserveGuardianRelease(reservation, Effect.sync(() => {
        deliveries += 1
      }).pipe(Effect.andThen(Effect.interrupt))).pipe(Effect.exit)
      yield* reserveGuardianRelease(reservation, Effect.sync(() => {
        deliveries += 1
      }))
      expect(deliveries).toBe(2)
    }))

  it.effect("delivers CONT atomically when interruption arrives after reservation", () =>
    Effect.gen(function*() {
      const reservation = yield* Ref.make(false)
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let deliveries = 0
      const first = yield* reserveGuardianRelease(reservation, Effect.gen(function*() {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(finish)
        deliveries += 1
      })).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const interrupted = yield* Fiber.interrupt(first).pipe(Effect.forkChild)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(interrupted)
      yield* reserveGuardianRelease(reservation, Effect.sync(() => {
        deliveries += 1
      }))
      expect(deliveries).toBe(1)
    }))

  it.live("freezes a guardian in the pre-evidence window and leaves no TERM-resistant child group", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-pre-evidence-" })
      const barrier = path.join(directory, "child-started")
      const handle = yield* spawner.spawn(ChildProcess.make("bash", [
        "-c",
        `set -m; (trap '' TERM; kill -STOP $BASHPID; sleep 30) & printf started > ${barrier}; kill -STOP $$; wait -f`
      ], { cwd: "." }))
      yield* handle.stdout.pipe(Stream.runDrain, Effect.forkScoped)
      yield* handle.stderr.pipe(Stream.runDrain, Effect.forkScoped)
      yield* fs.exists(barrier).pipe(
        Effect.filterOrFail((exists) => exists),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 })
      )

      let childPid = 0
      let childPgid = 0
      const processTable = () => runCommand(".", "ps", ["-eo", "pid=,ppid=,pgid="])
      yield* cleanupGuardianOwnership({
        evidence: undefined,
        signalGroup: (signal, pgid) => runJobControlCommand(".", [
          "signal",
          signal.slice(3),
          String(pgid)
        ]).pipe(Effect.asVoid),
        freezeGuardian: runCommand(".", "kill", ["-STOP", String(handle.pid)]).pipe(
          Effect.flatMap((report) => report.exitCode === 0
            ? Effect.void
            : Effect.fail(new BinarySmokeError({ operation: "cleanup", detail: "guardian freeze failed" })))
        ),
        discoverStartupGroup: processTable().pipe(Effect.flatMap((report) => Effect.sync(() => {
          const child = report.stdout.split("\n").flatMap((row) => {
            const match = /^\s*([1-9][0-9]*)\s+([1-9][0-9]*)\s+([1-9][0-9]*)\s*$/.exec(row)
            return match !== null && Number(match[2]) === Number(handle.pid) ? [[Number(match[1]), Number(match[3])] as const] : []
          })[0]
          if (child === undefined) return Option.none<number>()
          childPid = child[0]
          childPgid = child[1]
          return Option.some(childPgid)
        }))),
        groupAlive: (pgid) => processTable().pipe(
          Effect.map((report) => parseProcessGroupRows(report.stdout.split("\n").map((row) => {
            const fields = row.trim().split(/\s+/)
            return fields.length === 3 ? `${fields[0]} ${fields[2]}` : row
          }).join("\n"), pgid).length > 0)
        ),
        signalGuardian: (signal) => runCommand(".", "kill", [`-${signal.slice(3)}`, String(handle.pid)]).pipe(
          Effect.flatMap((report) => report.exitCode === 0
            ? Effect.void
            : Effect.fail(new BinarySmokeError({ operation: "cleanup", detail: "guardian signal failed" })))
        ),
        guardianRunning: processControl.probe(Number(handle.pid)).pipe(
          Effect.map((status) => status !== "dead"),
          Effect.mapError((cause) => new BinarySmokeError({ operation: "cleanup", detail: "guardian probe failed", cause }))
        ),
        releaseGuardian: Effect.void,
        reapGuardian: processControl.probe(Number(handle.pid)).pipe(
          Effect.mapError((cause) => new BinarySmokeError({ operation: "cleanup", detail: "guardian reap failed", cause })),
          Effect.flatMap((status) => status === "dead"
            ? Effect.void
            : Effect.fail(new BinarySmokeError({ operation: "cleanup", detail: "guardian reap failed" })))
        ),
        artifactsRemain: Effect.succeed(false),
        wait: Effect.sleep("20 millis")
      })
      expect(childPid).toBeGreaterThan(0)
      expect(childPgid).toBeGreaterThan(0)
      expect(yield* processControl.probe(childPid)).toBe("dead")
      const remaining = yield* processTable()
      expect(parseProcessGroupRows(remaining.stdout.split("\n").map((row) => {
        const fields = row.trim().split(/\s+/)
        return fields.length === 3 ? `${fields[0]} ${fields[2]}` : row
      }).join("\n"), childPgid)).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, ProcessServices.layer)))))

  it("routes every fixture mode through one ChildProcess command helper", () => {
    for (const args of [["fact", "node"], ["guardian", "./dist/expand"], ["signal", "TERM", "123"]]) {
      const command = jobControlCommand(args, { cwd: "." })
      expect(command._tag).toBe("StandardCommand")
      if (command._tag === "StandardCommand") {
        expect(command.command).toBe("bash")
        expect(command.args).toEqual([JOB_CONTROL_FIXTURE, ...args])
      }
    }
  })

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

  it.live("keeps the guardian child stopped until production acknowledges ownership", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-guardian-handshake-" })
      const marker = path.join(directory, "started")
      const handle = yield* spawner.spawn(jobControlCommand([
        "guardian",
        "bash",
        "-c",
        `printf started > ${marker}`
      ], { cwd: "." }))
      const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.broadcast({ capacity: "unbounded", replay: 1 }))
      const statusFiber = yield* stdout.pipe(
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("status=")),
        Stream.runHead,
        Effect.forkChild
      )
      const evidence = yield* stdout.pipe(Stream.splitLines, Stream.runHead)
      expect(Option.isSome(evidence)).toBe(true)
      if (Option.isNone(evidence)) return
      const match = /pgid=([1-9][0-9]*)$/.exec(evidence.value)
      expect(match).not.toBeNull()
      if (match === null) return
      expect(yield* fs.exists(marker)).toBe(false)
      yield* acknowledgeGuardianOwnership(".", Number(match[1]))
      yield* fs.exists(marker).pipe(
        Effect.filterOrFail((exists) => exists),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 })
      )
      yield* Fiber.join(statusFiber)
      yield* handle.kill({ killSignal: "SIGCONT" })
      expect(Number(yield* handle.exitCode)).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer))))

  it.effect("starts the real health CLI under the guardian immediately after the build", () =>
    Effect.gen(function*() {
      const fixture = processSpawnerFixture([0, 0, 1], { stdout: ["", "expand v0.0.0-dev\n", ""] })
      const fiber = yield* certifyBinaries("/repo").pipe(
        Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
          makeTempDirectoryScoped: () => Effect.succeed("/tmp/cert"),
          makeDirectory: () => Effect.void,
          remove: () => Effect.void
        }), Path.layer, Layer.succeed(ProcessControl, {
          currentPid: 1,
          probe: () => Effect.succeed("dead" as const)
        }), fixture.layer)),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(fixture.records.length).toBeGreaterThanOrEqual(2)
      const guardian = fixture.records[2]?.command
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
      const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(interrupted)
      expect(fixture.records[2]?.releaseCount).toBe(1)
    }))

  it.live("interrupts the production coordinator after direct-server spawn with no surviving process", () =>
    Effect.gen(function*() {
      const directSpawned = yield* Deferred.make<void>()
      const directExited = yield* Deferred.make<void>()
      const kills: Array<string> = []
      let phase: "auto" | "direct" = "auto"
      let autoAcknowledged = false
      let endpointChecks = 0
      let directPid = 0
      let directRunning = false
      let directReleaseCount = 0
      let nextPid = 10
      const layer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const pid = nextPid++
          const standard = command._tag === "StandardCommand" ? command : undefined
          const guardian = standard?.command === "bash" && standard.args.includes("guardian")
          if (standard?.command === "bash" && standard.args.includes("signal") && standard.args.includes("CONT")) autoAcknowledged = true
          const direct = standard?.command === "./dist/expand-server"
          const pgid = standard?.command === "ps" && standard.args.includes("pgid=")
          let guardianRunning = guardian
          if (direct) {
            phase = "direct"
            endpointChecks = 0
            directPid = pid
            directRunning = true
          }
          const version = standard?.command === "./dist/expand" && standard.args.length === 1 && standard.args[0] === "--version"
          const stdout = guardian
            ? "job=%2 pid=41 jobPid=41 pgid=91\n{\"kind\":\"ServerHealth\",\"data\":{\"status\":\"ok\"}}\nstatus=0\n"
            : version ? "expand v0.0.0-dev\n" : pgid ? "91\n" : ""
          return Effect.acquireRelease(
            Effect.sync(() => ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(pid),
                exitCode: direct ? Deferred.await(directExited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))) : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.sync(() => guardianRunning || (direct && directRunning)),
                kill: (options) => Effect.gen(function*() {
                  if (guardian) guardianRunning = false
                  if (direct) {
                    kills.push(String(options?.killSignal))
                    directRunning = false
                    endpointChecks = 1
                    yield* Deferred.succeed(directExited, undefined)
                  }
                }),
                stdin: Sink.drain,
                stdout: Stream.fromEffect(Effect.yieldNow.pipe(Effect.as(stdout))).pipe(Stream.encodeText),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void)
              })).pipe(
                Effect.tap(() => direct ? Deferred.succeed(directSpawned, undefined) : Effect.void)
              ),
            () => Effect.sync(() => {
              if (direct) directReleaseCount += 1
            })
          )
        })
      )
      const fiber = yield* certifyBinaries("/repo").pipe(
        Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
          makeTempDirectoryScoped: () => Effect.succeed("/tmp/cert"),
          makeDirectory: () => Effect.void,
          remove: () => Effect.void,
          exists: (file) => Effect.sync(() => phase === "auto" && file.endsWith("server.json") && autoAcknowledged && endpointChecks++ === 0),
          readFileString: () => Effect.succeed(phase === "auto" ? "{\"pid\":41}" : `{\"pid\":${directPid}}`)
        }), Path.layer, Layer.succeed(ProcessControl, {
          currentPid: 1,
          probe: (pid) => Effect.sync(() => pid === directPid && directRunning ? "alive" as const : "dead" as const)
        }), layer)),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(directSpawned)
      yield* Fiber.interrupt(fiber)
      expect(kills).toEqual(["SIGTERM"])
      expect(directRunning).toBe(false)
      expect(directReleaseCount).toBe(1)
    }))

  it.effect("build is the first child step and interruption releases the active build", () =>
    Effect.gen(function*() {
      const fixture = processSpawnerFixture([], { neverExitAt: 0 })
      const fiber = yield* certifyBinaries("/repo").pipe(
        Effect.provide(Layer.mergeAll(FileSystem.layerNoop({ remove: () => Effect.void, makeDirectory: () => Effect.void, chmod: () => Effect.void }), Path.layer, Layer.succeed(ProcessControl, {
          currentPid: 1,
          probe: () => Effect.succeed("dead" as const)
        }), fixture.layer)),
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

  it.effect("freezes pre-evidence guardian acquisition and terminates the discovered group", () => {
    const events: Array<string> = []
    return cleanupGuardianOwnership({
      evidence: undefined,
      signalGroup: (signal) => Effect.sync(() => events.push(`group:${signal}`)),
      freezeGuardian: Effect.sync(() => events.push("guardian:SIGSTOP")),
      discoverStartupGroup: Effect.succeed(Option.some(91)),
      groupAlive: (pgid) => Effect.sync(() => {
        events.push(`verify:${pgid}`)
        return false
      }),
      signalGuardian: (signal) => Effect.sync(() => events.push(`guardian:${signal}`)),
      guardianRunning: Effect.succeed(false),
      releaseGuardian: Effect.sync(() => events.push("release")),
      reapGuardian: Effect.sync(() => events.push("reap")),
      artifactsRemain: Effect.succeed(false),
      wait: Effect.void
    }).pipe(Effect.tap(() => Effect.sync(() => {
      expect(events).toEqual([
        "guardian:SIGSTOP",
        "group:SIGTERM",
        "verify:91",
        "guardian:SIGTERM",
        "reap",
        "verify:91"
      ])
    })))
  })

  it.effect("fails pre-evidence cleanup when a discoverable startup child survives guardian reap", () => {
    const events: Array<string> = []
    return cleanupGuardianOwnership({
      evidence: undefined,
      signalGroup: () => Effect.void,
      freezeGuardian: Effect.sync(() => events.push("guardian:SIGSTOP")),
      discoverStartupGroup: Effect.succeed(Option.some(91)),
      groupAlive: () => Effect.sync(() => {
        events.push("discover")
        return true
      }),
      signalGuardian: () => Effect.void,
      guardianRunning: Effect.succeed(false),
      releaseGuardian: Effect.void,
      reapGuardian: Effect.sync(() => events.push("reap")),
      artifactsRemain: Effect.succeed(false),
      wait: Effect.void
    }).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error.detail).toContain("startup child")
        expect(events).toEqual(["guardian:SIGSTOP", "discover", "discover", "reap", "discover"])
      }))
    )
  })

  it.effect("terminates the exact evidenced group with TERM and reaps the guardian once", () => {
    const events: Array<string> = []
    return cleanupGuardianOwnership({
      evidence: { job: "%2", pid: 41, pgid: 91 },
      signalGroup: (signal, pgid) => Effect.sync(() => events.push(`${signal}:${pgid}`)),
      freezeGuardian: Effect.sync(() => events.push("guardian:SIGSTOP")),
      discoverStartupGroup: Effect.succeed(Option.none()),
      groupAlive: () => Effect.succeed(false),
      signalGuardian: (signal) => Effect.sync(() => events.push(`guardian:${signal}`)),
      guardianRunning: Effect.succeed(true),
      releaseGuardian: Effect.sync(() => events.push("release")),
      reapGuardian: Effect.sync(() => events.push("reap")),
      artifactsRemain: Effect.succeed(false),
      wait: Effect.void
    }).pipe(Effect.tap(() => Effect.sync(() => {
      expect(events).toEqual(["SIGTERM:91", "release", "reap"])
    })))
  })

  it.effect("escalates a TERM-resistant group to KILL before guardian reap", () => {
    const events: Array<string> = []
    let checks = 0
    return cleanupGuardianOwnership({
      evidence: { job: "%2", pid: 41, pgid: 91 },
      signalGroup: (signal, pgid) => Effect.sync(() => events.push(`${signal}:${pgid}`)),
      freezeGuardian: Effect.sync(() => events.push("guardian:SIGSTOP")),
      discoverStartupGroup: Effect.succeed(Option.none()),
      groupAlive: () => Effect.sync(() => ++checks === 1),
      signalGuardian: (signal) => Effect.sync(() => events.push(`guardian:${signal}`)),
      guardianRunning: Effect.succeed(true),
      releaseGuardian: Effect.sync(() => events.push("release")),
      reapGuardian: Effect.sync(() => events.push("reap")),
      artifactsRemain: Effect.succeed(false),
      wait: Effect.void
    }).pipe(Effect.tap(() => Effect.sync(() => {
      expect(events).toEqual(["SIGTERM:91", "SIGKILL:91", "release", "reap"])
    })))
  })

  it.effect("releases and reaps the guardian once when the group survives KILL", () => {
    const events: Array<string> = []
    return cleanupGuardianOwnership({
      evidence: { job: "%2", pid: 41, pgid: 91 },
      signalGroup: (signal) => Effect.sync(() => events.push(signal)),
      freezeGuardian: Effect.sync(() => events.push("guardian:SIGSTOP")),
      discoverStartupGroup: Effect.succeed(Option.none()),
      groupAlive: () => Effect.succeed(true),
      signalGuardian: () => Effect.void,
      guardianRunning: Effect.succeed(true),
      releaseGuardian: Effect.sync(() => events.push("release")),
      reapGuardian: Effect.sync(() => events.push("reap")),
      artifactsRemain: Effect.succeed(false),
      wait: Effect.void
    }).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toMatchObject({ operation: "cleanup", detail: expect.stringContaining("survived KILL") })
        expect(events).toEqual(["SIGTERM", "SIGKILL", "release", "reap"])
      }))
    )
  })

  it.effect("bounds directly-owned server cleanup with TERM, KILL, and complete verification", () => {
    const events: Array<string> = []
    let probes = 0
    return cleanupDirectServer({
      signal: (signal) => Effect.sync(() => events.push(signal)),
      probe: Effect.sync(() => ++probes < 3),
      artifactsRemain: Effect.succeed(false),
      wait: Effect.sync(() => events.push("wait"))
    }).pipe(Effect.tap(() => Effect.sync(() => {
      expect(events).toEqual(["SIGTERM", "wait", "SIGKILL", "wait"])
    })))
  })

  it.effect("continues release, reap, and verification after cleanup failures and aggregates every Cause", () => {
    const events: Array<string> = []
    const failure = (detail: string) => Effect.fail(new BinarySmokeError({ operation: "cleanup", detail }))
    return cleanupGuardianOwnership({
      evidence: { job: "%2", pid: 41, pgid: 91 },
      signalGroup: (signal) => Effect.sync(() => events.push(signal)).pipe(
        Effect.andThen(signal === "SIGTERM" ? failure("term failed") : Effect.void)
      ),
      freezeGuardian: Effect.sync(() => events.push("guardian:SIGSTOP")),
      discoverStartupGroup: Effect.succeed(Option.none()),
      groupAlive: () => Effect.succeed(false),
      signalGuardian: () => Effect.void,
      guardianRunning: Effect.succeed(true),
      releaseGuardian: Effect.sync(() => events.push("release")).pipe(Effect.andThen(failure("release failed"))),
      reapGuardian: Effect.sync(() => events.push("reap")).pipe(Effect.andThen(failure("reap failed"))),
      artifactsRemain: Effect.sync(() => {
        events.push("verify")
        return true
      }),
      wait: Effect.void
    }).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        expect(exit.cause.reasons.filter(Cause.isFailReason)).toHaveLength(4)
        expect(events).toEqual(["SIGTERM", "release", "reap", "verify"])
      }))
    )
  })

  it.effect("retains production direct-server parse and cleanup failures in the same Cause", () =>
    Effect.gen(function*() {
      const cleanup = new BinarySmokeError({ operation: "cleanup", detail: "artifact probe failed" })
      const fixture = processSpawnerFixture([], { neverExitAt: 0 })
      let existsCalls = 0
      const exit = yield* Effect.scoped(runOwnedCli({
        root: "/repo",
        dataDir: "/tmp/cert",
        home: "/tmp/home",
        args: ["health"],
        attempts: 0
      })).pipe(
        Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
          exists: () => Effect.suspend(() => ++existsCalls === 1 ? Effect.succeed(true) : Effect.die(cleanup)),
          readFileString: () => Effect.succeed("malformed")
        }), Path.layer, Layer.succeed(ProcessControl, {
          currentPid: 1,
          probe: () => Effect.succeed("dead" as const)
        }), fixture.layer)),
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(exit.cause.reasons.filter(Cause.isFailReason).flatMap(({ error }) => error instanceof BinarySmokeError ? [{
        operation: error.operation,
        detail: error.detail
      }] : [])).toContainEqual({ operation: "parse", detail: "endpoint was malformed" })
      expect(exit.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)).toContain(cleanup)
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
