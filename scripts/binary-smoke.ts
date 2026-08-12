import { NodeRuntime } from "@effect/platform-node"
import { ENVELOPE_VERSION } from "@expand/contracts/cli/version"
import { ProcessControl, type ProcessControlShape } from "@expand/contracts/process-control"
import { ProcessServices } from "@expand/server/runtime/node-process-control"
import { Cause, Config, Data, Effect, Exit, Fiber, FileSystem, Option, Path, Ref, Schedule, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  assessArtifacts,
  assessDeparture,
  parseEvidence,
  parseJobIdentity,
  parseStatus,
  readinessTransition,
  initialCertificationState,
  reapTransition,
  releaseTransition,
  timeoutTransition
} from "./binary-smoke-model"
import { resolveBuildAppVersion } from "./app-version"

export const JOB_CONTROL_FIXTURE = "scripts/fixtures/job-control.sh"

export const jobControlCommand = (args: ReadonlyArray<string>, options?: ChildProcess.CommandOptions) =>
  ChildProcess.make("bash", [JOB_CONTROL_FIXTURE, ...args], options)

export class BinarySmokeError extends Data.TaggedError("BinarySmokeError")<{
  readonly operation: "build" | "command" | "parse" | "readiness" | "cleanup"
  readonly detail: string
  readonly cause?: unknown
  readonly cleanup?: ReadonlyArray<string>
}> {}

export interface JobControlFact {
  readonly job: string
  readonly pid: number
  readonly pgid: number
  readonly exitStatus: number
}

interface CommandReport {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const commandError = (operation: BinarySmokeError["operation"], detail: string, cause?: unknown) =>
  new BinarySmokeError({ operation, detail, cause })

export interface GuardianOwnershipEvidence {
  readonly job: string
  readonly pid: number
  readonly pgid: number
}

export interface GuardianCleanupOperations<R> {
  readonly evidence: GuardianOwnershipEvidence | undefined
  readonly signalGroup: (signal: "SIGTERM" | "SIGKILL", pgid: number) => Effect.Effect<void, BinarySmokeError, R>
  readonly freezeGuardian: Effect.Effect<void, BinarySmokeError, R>
  readonly discoverStartupGroup: Effect.Effect<Option.Option<number>, BinarySmokeError, R>
  readonly groupAlive: (pgid: number) => Effect.Effect<boolean, BinarySmokeError, R>
  readonly signalGuardian: (signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void, BinarySmokeError, R>
  readonly guardianRunning: Effect.Effect<boolean, BinarySmokeError, R>
  readonly releaseGuardian: Effect.Effect<void, BinarySmokeError, R>
  readonly reapGuardian: Effect.Effect<void, BinarySmokeError, R>
  readonly artifactsRemain: Effect.Effect<boolean, BinarySmokeError, R>
  readonly wait: Effect.Effect<void, never, R>
}

export const cleanupGuardianOwnership: <R>(
  operations: GuardianCleanupOperations<R>
) => Effect.Effect<void, BinarySmokeError, R> = Effect.fn("BinarySmoke.cleanupGuardianOwnership")(
  <R>(operations: GuardianCleanupOperations<R>) => Effect.gen(function*() {
    let failures: Cause.Cause<BinarySmokeError> | undefined
    const attempt = <A>(effect: Effect.Effect<A, BinarySmokeError, R>) => Effect.exit(effect).pipe(
      Effect.map((exit) => {
        if (Exit.isSuccess(exit)) return Option.some(exit.value)
        failures = failures === undefined ? exit.cause : Cause.combine(failures, exit.cause)
        return Option.none<A>()
      })
    )
    const record = (error: BinarySmokeError) => attempt(Effect.fail(error))
    if (operations.evidence === undefined) {
      yield* attempt(operations.freezeGuardian)
      const startupGroup = Option.flatten(yield* attempt(operations.discoverStartupGroup))
      if (Option.isSome(startupGroup)) {
        yield* attempt(operations.signalGroup("SIGTERM", startupGroup.value))
        yield* operations.wait
        const aliveAfterTerm = yield* attempt(operations.groupAlive(startupGroup.value))
        if (Option.isNone(aliveAfterTerm) || aliveAfterTerm.value) {
          yield* attempt(operations.signalGroup("SIGKILL", startupGroup.value))
          yield* operations.wait
          yield* attempt(operations.groupAlive(startupGroup.value))
        }
      }
      yield* attempt(operations.signalGuardian("SIGTERM"))
      yield* operations.wait
      const runningAfterTerm = yield* attempt(operations.guardianRunning)
      if (Option.isNone(runningAfterTerm) || runningAfterTerm.value) {
        yield* attempt(operations.signalGuardian("SIGKILL"))
        yield* operations.wait
        const runningAfterKill = yield* attempt(operations.guardianRunning)
        if (Option.isNone(runningAfterKill) || runningAfterKill.value) {
          yield* record(commandError("cleanup", "guardian survived KILL"))
        }
      }
      yield* attempt(operations.reapGuardian)
      if (Option.isSome(startupGroup)) {
        const startupChildAlive = yield* attempt(operations.groupAlive(startupGroup.value))
        if (Option.isNone(startupChildAlive) || startupChildAlive.value) {
          yield* record(commandError("cleanup", "pre-evidence startup child survived guardian reap"))
        }
      }
    } else {
      yield* attempt(operations.signalGroup("SIGTERM", operations.evidence.pgid))
      yield* operations.wait
      const aliveAfterTerm = yield* attempt(operations.groupAlive(operations.evidence.pgid))
      if (Option.isNone(aliveAfterTerm) || aliveAfterTerm.value) {
        yield* attempt(operations.signalGroup("SIGKILL", operations.evidence.pgid))
        yield* operations.wait
        const aliveAfterKill = yield* attempt(operations.groupAlive(operations.evidence.pgid))
        if (Option.isNone(aliveAfterKill) || aliveAfterKill.value) {
          yield* record(commandError("cleanup", "owned process group survived KILL"))
        }
      }
      const guardianRunning = yield* attempt(operations.guardianRunning)
      if (Option.isNone(guardianRunning) || guardianRunning.value) yield* attempt(operations.releaseGuardian)
      yield* attempt(operations.reapGuardian)
      const aliveAfterReap = yield* attempt(operations.groupAlive(operations.evidence.pgid))
      if (Option.isNone(aliveAfterReap) || aliveAfterReap.value) {
        yield* record(commandError("cleanup", "owned process group remained after guardian reap"))
      }
    }
    const artifactsRemain = yield* attempt(operations.artifactsRemain)
    if (Option.isNone(artifactsRemain) || artifactsRemain.value) {
      yield* record(commandError("cleanup", "owned certification artifacts remained after cleanup"))
    }
    if (failures !== undefined) return yield* Effect.failCause(failures)
  })
)

export interface DirectServerCleanupOperations<R> {
  readonly signal: (signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void, BinarySmokeError, R>
  readonly probe: Effect.Effect<boolean, BinarySmokeError, R>
  readonly artifactsRemain: Effect.Effect<boolean, BinarySmokeError, R>
  readonly wait: Effect.Effect<void, never, R>
}

export const cleanupDirectServer: <R>(
  operations: DirectServerCleanupOperations<R>
) => Effect.Effect<void, BinarySmokeError, R> = Effect.fn("BinarySmoke.cleanupDirectServer")(
  <R>(operations: DirectServerCleanupOperations<R>) => Effect.gen(function*() {
    let failures: Cause.Cause<BinarySmokeError> | undefined
    const attempt = <A>(effect: Effect.Effect<A, BinarySmokeError, R>) => Effect.exit(effect).pipe(
      Effect.map((exit) => {
        if (Exit.isSuccess(exit)) return Option.some(exit.value)
        failures = failures === undefined ? exit.cause : Cause.combine(failures, exit.cause)
        return Option.none<A>()
      })
    )
    const running = yield* attempt(operations.probe)
    if (Option.isNone(running) || running.value) {
      yield* attempt(operations.signal("SIGTERM"))
      yield* operations.wait
      const afterTerm = yield* attempt(operations.probe)
      if (Option.isNone(afterTerm) || afterTerm.value) {
        yield* attempt(operations.signal("SIGKILL"))
        yield* operations.wait
      }
    }
    const afterKill = yield* attempt(operations.probe)
    if (Option.isNone(afterKill) || afterKill.value) {
      yield* attempt(Effect.fail(commandError("cleanup", "owned server process survived bounded cleanup")))
    }
    const artifacts = yield* attempt(operations.artifactsRemain)
    if (Option.isNone(artifacts) || artifacts.value) {
      yield* attempt(Effect.fail(commandError("cleanup", "owned server artifacts remained after cleanup")))
    }
    if (failures !== undefined) return yield* Effect.failCause(failures)
  })
)

export const reserveGuardianRelease = Effect.fn("BinarySmoke.reserveGuardianRelease")(
  <R, E>(reservation: Ref.Ref<boolean>, delivery: Effect.Effect<void, E, R>) => Effect.uninterruptible(
    Ref.modify(reservation, (started) => [!started, true] as const).pipe(
      Effect.flatMap((ownsRelease) => ownsRelease ? delivery : Effect.void),
      Effect.onExit((exit) => Exit.isFailure(exit) ? Ref.set(reservation, false) : Effect.void)
    )
  )
)

export const retainCleanupCause = Effect.fn("BinarySmoke.retainCleanupCause")(
  <A, E, R, E2, R2>(
    program: Effect.Effect<A, E, R>,
    cleanup: Effect.Effect<void, E2, R2>
  ): Effect.Effect<A, E | E2, R | R2> => Effect.exit(program).pipe(
    Effect.flatMap((primary) => Effect.exit(cleanup).pipe(
      Effect.flatMap((released) => {
        if (Exit.isFailure(primary)) {
          return Exit.isFailure(released)
            ? Effect.failCause(Cause.combine(primary.cause, released.cause))
            : Effect.failCause(primary.cause)
        }
        return Exit.isFailure(released) ? Effect.failCause(released.cause) : Effect.succeed(primary.value)
      })
    ))
  )
)

export interface BinaryOwnershipCoreOperations<
  Guardian,
  Evidence,
  EndpointState,
  LockState,
  ReleaseState,
  A,
  RSpawn,
  REvidence,
  REndpoint,
  RLocks,
  RRelease,
  RReap,
  RCleanup
> {
  readonly guardianSpawn: Effect.Effect<Guardian, unknown, RSpawn>
  readonly stoppedEvidence: (guardian: Guardian) => Effect.Effect<Evidence, unknown, REvidence>
  readonly endpointPublication: (guardian: Guardian, evidence: Evidence) => Effect.Effect<EndpointState, unknown, REndpoint>
  readonly lockObservation: (guardian: Guardian, endpoint: EndpointState) => Effect.Effect<LockState, unknown, RLocks>
  readonly release: (guardian: Guardian, locks: LockState) => Effect.Effect<ReleaseState, unknown, RRelease>
  readonly reap: (guardian: Guardian, released: ReleaseState) => Effect.Effect<A, unknown, RReap>
  readonly cleanup: (guardian: Guardian) => Effect.Effect<void, unknown, RCleanup>
}

export const runBinaryOwnershipCore = Effect.fn("BinarySmoke.runBinaryOwnershipCore")(
  <Guardian, Evidence, EndpointState, LockState, ReleaseState, A, RSpawn, REvidence, REndpoint, RLocks, RRelease, RReap, RCleanup>(
    operations: BinaryOwnershipCoreOperations<Guardian, Evidence, EndpointState, LockState, ReleaseState, A, RSpawn, REvidence, REndpoint, RLocks, RRelease, RReap, RCleanup>
  ) => Effect.uninterruptibleMask((restore) => operations.guardianSpawn.pipe(
    Effect.flatMap((guardian) => restore(retainCleanupCause(
      Effect.gen(function*() {
        const evidence = yield* operations.stoppedEvidence(guardian)
        const endpoint = yield* operations.endpointPublication(guardian, evidence)
        const locks = yield* operations.lockObservation(guardian, endpoint)
        const released = yield* operations.release(guardian, locks)
        return yield* operations.reap(guardian, released)
      }),
      operations.cleanup(guardian)
    )))
  ))
)

const model = <A>(operation: BinarySmokeError["operation"], evaluate: () => A): Effect.Effect<A, BinarySmokeError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => commandError(operation, "binary certification state transition failed", cause)
  })

const collectHandle = Effect.fn("BinarySmoke.collectHandle")((handle: ChildProcessHandle) =>
  Effect.all([
    handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
    handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    handle.exitCode
  ], { concurrency: "unbounded" }).pipe(
    Effect.map(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode: Number(exitCode) })),
    Effect.mapError((cause) => commandError("command", "child process failed", cause))
  ))

export const runCommand = Effect.fn("BinarySmoke.runCommand")(
  (root: string, command: string, args: ReadonlyArray<string>, env?: Record<string, string | undefined>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
        cwd: root,
        env,
        extendEnv: true
      })).pipe(Effect.mapError((cause) => commandError("command", `${command} could not start`, cause)))
      return yield* collectHandle(handle)
    }))
)

export const runJobControlCommand = Effect.fn("BinarySmoke.runJobControlCommand")(
  (root: string, args: ReadonlyArray<string>) => Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(jobControlCommand(args, { cwd: root })).pipe(
      Effect.mapError((cause) => commandError("command", "job-control fixture could not start", cause))
    )
    return yield* collectHandle(handle)
  }))
)

const requireSuccess = (report: CommandReport, label: string): Effect.Effect<CommandReport, BinarySmokeError> =>
  report.exitCode === 0
    ? Effect.succeed(report)
    : Effect.fail(commandError("command", `${label} exited ${report.exitCode}: ${report.stderr.trim()}`))

export const certifyCompiledVersion = Effect.fn("BinarySmoke.certifyCompiledVersion")(
  function*(root: string, expectedVersion: string) {
    const report = yield* runCommand(root, "./dist/expand", ["--version"]).pipe(
      Effect.flatMap((result) => requireSuccess(result, "compiled version"))
    )
    const version = report.stdout.trim()
    if (version !== `expand v${expectedVersion}`) {
      return yield* commandError("parse", `compiled version did not match resolved build identity ${expectedVersion}: ${version}`)
    }
  }
)

const JobFactOutput = Schema.Struct({
  job: Schema.String,
  pid: Schema.Number,
  pgid: Schema.Number,
  exitStatus: Schema.Number
})

const decodeGuardianEvidence = (source: string): Effect.Effect<GuardianOwnershipEvidence, BinarySmokeError> => Effect.gen(function*() {
  const match = /^job=(%[1-9][0-9]*) pid=([1-9][0-9]*) jobPid=([1-9][0-9]*) pgid=([1-9][0-9]*)$/.exec(source)
  if (match === null) return yield* commandError("parse", "guardian ownership evidence was malformed")
  const identity = yield* model("parse", () => parseJobIdentity(`[${match[1]!.slice(1)}] ${match[3]!} Running`, Number(match[2]!)))
  return { job: identity.job, pid: identity.pid, pgid: Number(match[4]) }
})

const decodeJobFact = (source: string): Effect.Effect<JobControlFact, BinarySmokeError> => Effect.gen(function*() {
  const match = /(?:^|\n)job=(%[1-9][0-9]*) pid=([1-9][0-9]*) jobPid=([1-9][0-9]*) pgid=([1-9][0-9]*)\n[\s\S]*?status=([0-9]{1,3})(?:\n|$)/.exec(source)
  if (match === null) return yield* commandError("parse", "job-control evidence was malformed")
  const identity = yield* model("parse", () => parseJobIdentity(`[${match[1]!.slice(1)}] ${match[3]!} Running`, Number(match[2]!)))
  return yield* Schema.decodeUnknownEffect(JobFactOutput)({
    job: identity.job,
    pid: identity.pid,
    pgid: Number(match[4]),
    exitStatus: Number(match[5])
  }).pipe(Effect.mapError((cause) => commandError("parse", "job-control evidence was malformed", cause)))
})

export const runJobControlFact = Effect.fn("BinarySmoke.runJobControlFact")(
  function*(root: string, command: ReadonlyArray<string>) {
    const [executable, ...args] = command
    if (executable === undefined) return yield* commandError("command", "job-control command was empty")
    const report = yield* runJobControlCommand(root, ["fact", executable, ...args])
    if (report.stderr !== "") return yield* commandError("command", `job-control fixture wrote stderr: ${report.stderr.trim()}`)
    return yield* decodeJobFact(report.stdout)
  }
)

const Endpoint = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) }))
export const Health = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal(ENVELOPE_VERSION),
  kind: Schema.Literal("ServerHealth"),
  data: Schema.Struct({ status: Schema.Literal("ok") })
}))
const Created = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal(ENVELOPE_VERSION),
  kind: Schema.Literal("Project"),
  created: Schema.Literal(true),
  data: Schema.Struct({ id: Schema.String })
}))
const Listed = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal(ENVELOPE_VERSION),
  kind: Schema.Literal("ProjectList"),
  data: Schema.Array(Schema.Struct({ name: Schema.String }))
}))
const JsonEnvelope = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal(ENVELOPE_VERSION)
}))

export const decodeOutput = Effect.fn("BinarySmoke.decodeOutput")(
  <A>(schema: Schema.Codec<A, unknown, never, never>, source: string, label: string): Effect.Effect<A, BinarySmokeError> =>
    Schema.decodeUnknownEffect(schema)(source).pipe(
      Effect.mapError((cause) => commandError("parse", `${label} response was malformed`, cause))
    )
)

const awaitEndpoint = Effect.fn("BinarySmoke.awaitEndpoint")(
  function*(fs: FileSystem.FileSystem, endpointFile: string, handle: ChildProcessHandle, attempts: number) {
    const wait = Effect.gen(function*() {
      if (!(yield* handle.isRunning)) return yield* commandError("readiness", "recorded process exited during endpoint readiness")
      if (!(yield* fs.exists(endpointFile))) return yield* commandError("readiness", "endpoint was not advertised")
      const endpoint = yield* Schema.decodeUnknownEffect(Endpoint)(yield* fs.readFileString(endpointFile)).pipe(
        Effect.mapError((cause) => commandError("parse", "endpoint was malformed", cause))
      )
      if (!(yield* handle.isRunning)) return yield* commandError("readiness", "recorded process exited during endpoint readiness")
      return endpoint
    })
    return yield* wait.pipe(
      Effect.retry({
        schedule: Schedule.spaced("20 millis"),
        times: attempts,
        while: (error) => error._tag === "BinarySmokeError" && error.operation === "readiness" && error.detail === "endpoint was not advertised"
      }),
      Effect.catchIf(
        (cause) => cause._tag === "BinarySmokeError" && cause.operation === "readiness" && cause.detail === "endpoint was not advertised",
        () => model("readiness", () => timeoutTransition("endpoint-readiness"))
      )
    )
  }
)

const waitForExit = Effect.fn("BinarySmoke.waitForExit")(
  function*(handle: ChildProcessHandle, label: string) {
    const result = yield* handle.exitCode.pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.mapError((cause) => commandError("command", `${label} exit failed`, cause))
    )
    if (Option.isNone(result)) return yield* model("cleanup", () => timeoutTransition(label === "expand-server" ? "direct-server-exit" : "guardian-reap"))
    return Number(result.value)
  }
)

export const runOwnedCli = Effect.fn("BinarySmoke.runOwnedCli")(
  function*(options: {
    readonly root: string
    readonly dataDir: string
    readonly home: string
    readonly args: ReadonlyArray<string>
    readonly attempts: number
  }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const processControl = yield* ProcessControl
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const endpointFile = path.join(options.dataDir, "server.json")
    return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make("./dist/expand-server", ["--data-dir", options.dataDir], {
        cwd: options.root,
        env: { HOME: options.home, EXPAND_BACKEND_CMD: undefined },
        extendEnv: true
      })).pipe(Effect.mapError((cause) => commandError("command", "expand-server could not start", cause)))
      const directCleanup = cleanupDirectServer({
        signal: (signal) => handle.kill({ killSignal: signal }).pipe(
          Effect.mapError((cause) => commandError("cleanup", `${signal} server signal failed`, cause))
        ),
        probe: processControl.probe(Number(handle.pid)).pipe(
          Effect.map((status) => status !== "dead"),
          Effect.mapError((cause) => commandError("cleanup", "owned server process could not be observed", cause))
        ),
        artifactsRemain: Effect.all([
          fs.exists(endpointFile),
          fs.exists(`${endpointFile}.lock`),
          fs.exists(path.join(options.dataDir, "backend.lock"))
        ]).pipe(
          Effect.map(([endpoint, endpointLock, backendLock]) => endpoint || endpointLock || backendLock),
          Effect.mapError((cause) => commandError("cleanup", "owned server artifacts could not be observed", cause))
        ),
        wait: Effect.sleep("1 second")
      })
      const body = Effect.gen(function*() {
        yield* handle.stdout.pipe(Stream.runDrain, Effect.forkScoped)
        yield* handle.stderr.pipe(Stream.runDrain, Effect.forkScoped)
        const endpoint = yield* awaitEndpoint(fs, endpointFile, handle, options.attempts)
        const activeAfter = yield* handle.isRunning
        yield* model("readiness", () => readinessTransition(initialCertificationState(options.dataDir, Number(handle.pid)), {
          endpointPid: endpoint.pid,
          activeBefore: true,
          activeAfter
        }))
        const report = yield* runCommand(options.root, "./dist/expand", ["--data-dir", options.dataDir, ...options.args], {
          HOME: options.home,
          EXPAND_BACKEND_CMD: undefined
        }).pipe(Effect.flatMap((result) => requireSuccess(result, "expand")))
        const status = yield* waitForExit(handle, "expand-server")
        if (status !== 0) return yield* commandError("command", `expand-server exited ${status}`)
        const probe = yield* processControl.probe(Number(handle.pid))
        if (probe !== "dead") return yield* commandError("cleanup", "owned server process remained after exit")
        const remaining = {
          endpoint: yield* fs.exists(endpointFile),
          endpointLock: yield* fs.exists(`${endpointFile}.lock`),
          backendLock: yield* fs.exists(path.join(options.dataDir, "backend.lock"))
        }
        yield* model("cleanup", () => assessArtifacts(remaining))
        return report.stdout
      })
      return yield* retainCleanupCause(restore(body), directCleanup)
    }))
  }
)

const processGroupOf = Effect.fn("BinarySmoke.processGroupOf")(function*(root: string, pid: number) {
  const report = yield* runCommand(root, "ps", ["-o", "pgid=", "-p", String(pid)])
  if (report.exitCode !== 0 || !/^[1-9][0-9]*$/.test(report.stdout.trim())) {
    return yield* commandError("readiness", "endpoint process group was malformed")
  }
  return Number(report.stdout.trim())
})

export const parseProcessGroupRows = (source: string, pgid: number): ReadonlyArray<number> => {
  const rows = source.split("\n").filter((row) => row.trim() !== "")
  return rows.flatMap((row) => {
    const match = /^\s*([1-9][0-9]*)\s+(0|[1-9][0-9]*)\s*$/.exec(row)
    if (match === null) throw commandError("parse", "process table row was malformed")
    return Number(match[2]) === pgid ? [Number(match[1])] : []
  })
}

export const acknowledgeGuardianOwnership = Effect.fn("BinarySmoke.acknowledgeGuardianOwnership")(function*(root: string, pgid: number) {
  const report = yield* runJobControlCommand(root, ["signal", "CONT", String(pgid)])
  if (report.exitCode !== 0) return yield* commandError("cleanup", "guardian ownership acknowledgement failed")
})

const processGroupAlive = Effect.fn("BinarySmoke.processGroupAlive")(function*(root: string, pgid: number) {
  const report = yield* runCommand(root, "ps", ["-eo", "pid=,pgid="])
  if (report.exitCode !== 0) return yield* commandError("cleanup", "process table query failed")
  return yield* model("parse", () => parseProcessGroupRows(report.stdout, pgid)).pipe(Effect.map((pids) => pids.length > 0))
})

const observeDeparture = Effect.fn("BinarySmoke.observeDeparture")(function*(
  root: string,
  fs: FileSystem.FileSystem,
  processControl: ProcessControlShape,
  files: { readonly endpoint: string; readonly endpointLock: string; readonly backendLock: string },
  pid: number,
  pgid: number,
  attempts: number
) {
  const observe = Effect.gen(function*() {
    const remaining = {
      endpoint: yield* fs.exists(files.endpoint),
      endpointLock: yield* fs.exists(files.endpointLock),
      backendLock: yield* fs.exists(files.backendLock),
      processInGroup: (yield* processGroupAlive(root, pgid)) || (yield* processControl.probe(pid)) !== "dead"
    }
    if (remaining.endpoint || remaining.endpointLock || remaining.backendLock || remaining.processInGroup) {
      return yield* commandError("cleanup", "auto-spawn departure pending")
    }
    return remaining
  })
  return yield* observe.pipe(
    Effect.retry({
      schedule: Schedule.spaced("20 millis"),
      times: attempts,
      while: (error) => error._tag === "BinarySmokeError" && error.operation === "cleanup" && error.detail === "auto-spawn departure pending"
    }),
    Effect.catchIf(
      (cause) => cause._tag === "BinarySmokeError" && cause.operation === "cleanup" && cause.detail === "auto-spawn departure pending",
      () => model("cleanup", () => timeoutTransition("backend-departure"))
    )
  )
})

const guardianStartupGroup = Effect.fn("BinarySmoke.guardianStartupGroup")(function*(root: string, guardianPid: number) {
  const report = yield* runCommand(root, "ps", ["-eo", "pid=,ppid=,pgid="])
  if (report.exitCode !== 0) return yield* commandError("cleanup", "guardian child process query failed")
  return yield* model("parse", () => {
    const groups = report.stdout.split("\n").filter((row) => row.trim() !== "").flatMap((row) => {
      const match = /^\s*([1-9][0-9]*)\s+([1-9][0-9]*)\s+([1-9][0-9]*)\s*$/.exec(row)
      if (match === null) throw commandError("parse", "guardian child process table row was malformed")
      return Number(match[2]) === guardianPid ? [Number(match[3])] : []
    })
    if (groups.length > 1 && groups.some((group) => group !== groups[0])) {
      throw commandError("parse", "guardian startup children occupied multiple process groups")
    }
    return groups[0] === undefined ? Option.none() : Option.some(groups[0])
  })
})

const autoSpawnHealth = Effect.fn("BinarySmoke.autoSpawnHealth")(function*(options: {
  readonly root: string
  readonly dataDir: string
  readonly home: string
  readonly attempts: number
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processControl = yield* ProcessControl
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const endpointFile = path.join(options.dataDir, "server.json")
  const evidenceRef = yield* Ref.make<GuardianOwnershipEvidence | undefined>(undefined)
  const releaseStarted = yield* Ref.make(false)
  const reapStarted = yield* Ref.make(false)
  const cleanupStarted = yield* Ref.make(false)
  return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
  const guardianSpawn = spawner.spawn(jobControlCommand([
    "guardian",
    "./dist/expand",
    "--data-dir",
    options.dataDir,
    "health",
    "--format",
    "json"
  ], {
    cwd: options.root,
    env: { HOME: options.home, EXPAND_BACKEND_CMD: undefined },
    extendEnv: true
  })).pipe(Effect.mapError((cause) => commandError("command", "auto-spawn guardian could not start", cause)))
  const signalGroup = Effect.fn("BinarySmoke.signalGroup")(function*(signal: "SIGTERM" | "SIGKILL", pgid: number) {
    const report = yield* runJobControlCommand(options.root, ["signal", signal.slice(3), String(pgid)])
    if (report.exitCode !== 0 && (yield* processGroupAlive(options.root, pgid))) {
      return yield* commandError("cleanup", `${signal} process-group signal failed`)
    }
  })
  const releaseGuardian = (handle: ChildProcessHandle) => reserveGuardianRelease(
    releaseStarted,
    handle.kill({ killSignal: "SIGCONT" }).pipe(
      Effect.mapError((cause) => commandError("cleanup", "guardian release failed", cause))
    )
  )
  const reapGuardian = (handle: ChildProcessHandle) => Ref.modify(reapStarted, (started) => [!started, true] as const).pipe(
    Effect.flatMap((ownsReap) => ownsReap
      ? handle.exitCode.pipe(
        Effect.timeoutOption("1 second"),
        Effect.flatMap(Option.match({
          onNone: () => model("cleanup", () => timeoutTransition("guardian-reap")),
          onSome: () => Effect.void
        })),
        Effect.matchEffect({
          onFailure: (cause) => processControl.probe(Number(handle.pid)).pipe(
            Effect.mapError((probeCause) => commandError("cleanup", "guardian state could not be observed", probeCause)),
            Effect.flatMap((status) => status === "dead"
              ? Effect.void
              : Effect.fail(cause instanceof BinarySmokeError ? cause : commandError("cleanup", "guardian reap failed", cause)))
          ),
          onSuccess: () => Effect.void
        }),
        Effect.tapError(() => Ref.set(reapStarted, false))
      )
      : Effect.void)
  )
  const cleanup = (handle: ChildProcessHandle) => Ref.modify(cleanupStarted, (started) => [!started, true] as const).pipe(
    Effect.flatMap((ownsCleanup) => ownsCleanup
      ? Ref.get(evidenceRef).pipe(
        Effect.flatMap((evidence) => cleanupGuardianOwnership({
          evidence,
          signalGroup,
          freezeGuardian: runCommand(options.root, "kill", ["-STOP", String(handle.pid)]).pipe(
            Effect.flatMap((report) => report.exitCode === 0
              ? Effect.void
              : handle.isRunning.pipe(
                Effect.mapError((cause) => commandError("cleanup", "guardian state could not be observed", cause)),
                Effect.flatMap((running) => running
                  ? Effect.fail(commandError("cleanup", "guardian freeze failed"))
                  : Effect.void)
              ))
          ),
          discoverStartupGroup: guardianStartupGroup(options.root, Number(handle.pid)),
          groupAlive: (pgid) => processGroupAlive(options.root, pgid),
          signalGuardian: (signal) => runCommand(options.root, "kill", [`-${signal.slice(3)}`, String(handle.pid)]).pipe(
            Effect.flatMap((report) => report.exitCode === 0
              ? Effect.void
              : processControl.probe(Number(handle.pid)).pipe(
                Effect.mapError((cause) => commandError("cleanup", "guardian state could not be observed", cause)),
                Effect.flatMap((status) => status === "dead"
                  ? Effect.void
                  : Effect.fail(commandError("cleanup", `${signal} guardian signal failed`)))
              ))
          ),
          guardianRunning: processControl.probe(Number(handle.pid)).pipe(
            Effect.map((status) => status !== "dead"),
            Effect.mapError((cause) => commandError("cleanup", "guardian state could not be observed", cause))
          ),
          releaseGuardian: releaseGuardian(handle),
          reapGuardian: reapGuardian(handle),
          artifactsRemain: Effect.all([
            fs.exists(endpointFile),
            fs.exists(`${endpointFile}.lock`),
            fs.exists(path.join(options.dataDir, "backend.lock"))
          ]).pipe(
            Effect.map(([endpoint, endpointLock, backendLock]) => endpoint || endpointLock || backendLock),
            Effect.mapError((cause) => commandError("cleanup", "owned artifacts could not be observed", cause))
          ),
          wait: Effect.sleep("1 second")
        })),
        Effect.tapError(() => Ref.set(cleanupStarted, false))
      )
      : Effect.void)
  )
  const core = runBinaryOwnershipCore({
    guardianSpawn,
    stoppedEvidence: (handle) => Effect.gen(function*() {
      const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.broadcast({ capacity: "unbounded", replay: 1 }))
      const evidenceFiber = yield* stdout.pipe(
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("job=")),
        Stream.runHead,
        Effect.flatMap((line) => Option.match(line, {
          onNone: () => Effect.fail(commandError("parse", "guardian ownership evidence was not recorded")),
          onSome: decodeGuardianEvidence
        })),
        Effect.forkScoped
      )
      const collected = yield* Effect.all([
        stdout.pipe(Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" }).pipe(
        Effect.map(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode: Number(exitCode) })),
        Effect.mapError((cause) => commandError("command", "guardian process failed", cause)),
        Effect.forkScoped
      )
      const ownershipEvidence = yield* Fiber.join(evidenceFiber)
      yield* Ref.set(evidenceRef, ownershipEvidence)
      yield* acknowledgeGuardianOwnership(options.root, ownershipEvidence.pgid)
      return { collected, ownershipEvidence }
    }),
    endpointPublication: (handle, { collected, ownershipEvidence }) => Effect.gen(function*() {
      const endpoint = yield* awaitEndpoint(fs, endpointFile, handle, options.attempts)
      const pgid = yield* processGroupOf(options.root, endpoint.pid)
      yield* model("parse", () => parseEvidence(`${endpoint.pid} ${pgid}\n`, ownershipEvidence.pgid))
      const guardianActive = yield* handle.isRunning
      const state = yield* model("readiness", () => readinessTransition(
        initialCertificationState(options.dataDir, endpoint.pid, { pgid, job: ownershipEvidence.job }),
        { endpointPid: endpoint.pid, activeBefore: true, activeAfter: guardianActive }
      ))
      return { collected, endpoint, ownershipEvidence, pgid, state }
    }),
    lockObservation: (_handle, current) => Effect.gen(function*() {
      const remaining = yield* observeDeparture(options.root, fs, processControl, {
        endpoint: endpointFile,
        endpointLock: `${endpointFile}.lock`,
        backendLock: path.join(options.dataDir, "backend.lock")
      }, current.endpoint.pid, current.pgid, options.attempts)
      return { ...current, state: yield* model("cleanup", () => assessDeparture(current.state, remaining)) }
    }),
    release: (handle, current) => Effect.gen(function*() {
      const state = yield* model("cleanup", () => releaseTransition(current.state))
      yield* releaseGuardian(handle)
      return { ...current, state }
    }),
    reap: (_handle, current) => Effect.gen(function*() {
      const report = yield* Fiber.join(current.collected)
      yield* Ref.set(reapStarted, true)
      const fact = yield* decodeJobFact(report.stdout)
      if (fact.job !== current.ownershipEvidence.job || fact.pid !== current.ownershipEvidence.pid || fact.pgid !== current.ownershipEvidence.pgid) {
        return yield* commandError("parse", "guardian ownership evidence was replaced")
      }
      yield* model("parse", () => parseEvidence(`${current.endpoint.pid} ${current.pgid}\n`, fact.pgid))
      const status = yield* model("parse", () => parseStatus(`${fact.exitStatus}\n`))
      const state = yield* model("cleanup", () => reapTransition(current.state, status))
      if (state.exitStatus !== 0 || report.exitCode !== 0) {
        return yield* commandError("command", `auto-spawn health exited ${state.exitStatus ?? report.exitCode}`)
      }
      const output = report.stdout.split("\n").filter((line) => !line.startsWith("job=") && !line.startsWith("status=")).join("\n").trim()
      return yield* decodeOutput(Health, output, "health")
    }),
    cleanup
  })
  return yield* restore(core).pipe(
    Effect.mapError((cause) => cause instanceof BinarySmokeError ? cause : commandError("command", "binary ownership core failed", cause))
  )
  }))
})

export const certifyBinaries = Effect.fn("BinarySmoke.certifyBinaries")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* runCommand(root, "tsx", ["scripts/build.ts"]).pipe(
      Effect.flatMap((report) => requireSuccess(report, "binary build")),
      Effect.mapError((cause) => cause.operation === "command" ? new BinarySmokeError({ ...cause, operation: "build" }) : cause)
    )
    const expectedVersion = yield* resolveBuildAppVersion(root)
    yield* certifyCompiledVersion(root, expectedVersion)
    const attempts = yield* Config.int("EXPAND_BINARY_SMOKE_ATTEMPTS").pipe(Config.withDefault(250))
    yield* Effect.scoped(Effect.gen(function*() {
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-binary-smoke-" })
      const home = path.join(dataDir, "default-sentinel")
      const project = path.join(dataDir, "project")
      yield* fs.makeDirectory(home, { recursive: true })
      yield* fs.makeDirectory(project, { recursive: true })
      yield* autoSpawnHealth({ root, dataDir, home, attempts })
      const createdSource = yield* runOwnedCli({
        root,
        dataDir,
        home,
        attempts,
        args: ["project", "create", "binary-smoke", "--directory", project, "--format", "json"]
      })
      const created = yield* decodeOutput(Created, createdSource, "create")
      const listedSource = yield* runOwnedCli({
        root,
        dataDir,
        home,
        attempts,
        args: ["project", "list", "--format", "json"]
      })
      const listed = yield* decodeOutput(Listed, listedSource, "list")
      if (!listed.data.some(({ name }) => name === "binary-smoke")) {
        return yield* commandError("parse", "created project was absent from list")
      }
      const deletedSource = yield* runOwnedCli({
        root,
        dataDir,
        home,
        attempts,
        args: ["project", "delete", created.data.id, "--format", "json"]
      })
      yield* decodeOutput(JsonEnvelope, deletedSource, "delete")
      if (!(yield* fs.exists(path.join(dataDir, "events.db")))) {
        return yield* commandError("cleanup", "events database was not durable")
      }
      if (yield* fs.exists(path.join(home, ".expand"))) {
        return yield* commandError("cleanup", "default data directory was used")
      }
    }))
  }
)

const program = Path.Path.pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../", import.meta.url))),
  Effect.flatMap(certifyBinaries),
  Effect.provide(ProcessServices.layer)
)

if (import.meta.main) {
  NodeRuntime["runMain"](program)
}
