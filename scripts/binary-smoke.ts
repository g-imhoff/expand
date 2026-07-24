import { NodeRuntime } from "@effect/platform-node"
import { ProcessControl } from "@expand/contracts/process-control"
import { ProcessServices } from "@expand/server/node-process-control"
import { Config, Data, Effect, FileSystem, Option, Path, Schedule, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { assessArtifacts, parseEvidence, parseStatus, readinessTransition, initialCertificationState } from "./binary-smoke-model"

export const JOB_CONTROL_FIXTURE = "scripts/fixtures/job-control.sh"

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

const runCommand = Effect.fn("BinarySmoke.runCommand")(
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

const requireSuccess = (report: CommandReport, label: string): Effect.Effect<CommandReport, BinarySmokeError> =>
  report.exitCode === 0
    ? Effect.succeed(report)
    : Effect.fail(commandError("command", `${label} exited ${report.exitCode}: ${report.stderr.trim()}`))

const JobFactOutput = Schema.Struct({
  job: Schema.String,
  pid: Schema.Number,
  pgid: Schema.Number,
  exitStatus: Schema.Number
})

const decodeJobFact = (source: string): Effect.Effect<JobControlFact, BinarySmokeError> => Effect.gen(function*() {
  const match = /^job=(%[1-9][0-9]*) pid=([1-9][0-9]*) pgid=([1-9][0-9]*)\nstatus=([0-9]{1,3})\n$/.exec(source)
  if (match === null) return yield* commandError("parse", "job-control evidence was malformed")
  return yield* Schema.decodeUnknownEffect(JobFactOutput)({
    job: match[1],
    pid: Number(match[2]),
    pgid: Number(match[3]),
    exitStatus: Number(match[4])
  }).pipe(Effect.mapError((cause) => commandError("parse", "job-control evidence was malformed", cause)))
})

export const runJobControlFact = Effect.fn("BinarySmoke.runJobControlFact")(
  function*(root: string, command: ReadonlyArray<string>) {
    const [executable, ...args] = command
    if (executable === undefined) return yield* commandError("command", "job-control command was empty")
    const report = yield* runCommand(root, "bash", [JOB_CONTROL_FIXTURE, executable, ...args])
    if (report.stderr !== "") return yield* commandError("command", `job-control fixture wrote stderr: ${report.stderr.trim()}`)
    return yield* decodeJobFact(report.stdout)
  }
)

const Endpoint = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) }))
const Health = Schema.fromJsonString(Schema.Struct({
  kind: Schema.Literal("ServerHealth"),
  data: Schema.Struct({ status: Schema.Literal("ok") })
}))
const Created = Schema.fromJsonString(Schema.Struct({
  kind: Schema.Literal("Project"),
  created: Schema.Literal(true),
  data: Schema.Struct({ id: Schema.String })
}))
const Listed = Schema.fromJsonString(Schema.Struct({
  kind: Schema.Literal("ProjectList"),
  data: Schema.Array(Schema.Struct({ name: Schema.String }))
}))
const JsonValue = Schema.fromJsonString(Schema.Unknown)

const decodeOutput = Effect.fn("BinarySmoke.decodeOutput")(
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
      Effect.retry({ schedule: Schedule.spaced("20 millis"), times: attempts }),
      Effect.mapError((cause) => commandError("readiness", "endpoint readiness timed out", cause))
    )
  }
)

const waitForExit = Effect.fn("BinarySmoke.waitForExit")(
  function*(handle: ChildProcessHandle, label: string) {
    const result = yield* handle.exitCode.pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.mapError((cause) => commandError("command", `${label} exit failed`, cause))
    )
    if (Option.isNone(result)) return yield* commandError("cleanup", `${label} exit timed out`)
    return Number(result.value)
  }
)

const stopOwned = Effect.fn("BinarySmoke.stopOwned")((handle: ChildProcessHandle) =>
  handle.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(
    Effect.mapError((cause) => commandError("cleanup", "TERM-to-KILL cleanup failed", cause))
  ))

const runOwnedCli = Effect.fn("BinarySmoke.runOwnedCli")(
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
    const handle = yield* spawner.spawn(ChildProcess.make("./dist/expand-server", ["--data-dir", options.dataDir], {
      cwd: options.root,
      env: { HOME: options.home, EXPAND_BACKEND_CMD: undefined },
      extendEnv: true
    })).pipe(Effect.mapError((cause) => commandError("command", "expand-server could not start", cause)))
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
    const status = yield* waitForExit(handle, "expand-server").pipe(
      Effect.onError(() => Effect.ignore(stopOwned(handle)))
    )
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
  }
)

export const certifyBinaries = Effect.fn("BinarySmoke.certifyBinaries")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* runCommand(root, "tsx", ["scripts/build.ts"]).pipe(
      Effect.flatMap((report) => requireSuccess(report, "binary build")),
      Effect.mapError((cause) => cause.operation === "command" ? new BinarySmokeError({ ...cause, operation: "build" }) : cause)
    )
    const attempts = yield* Config.int("EXPAND_BINARY_SMOKE_ATTEMPTS").pipe(Config.withDefault(250))
    const fact = yield* runJobControlFact(root, ["bash", "-c", "sleep 0.05; exit 23"])
    yield* model("parse", () => parseEvidence(`${fact.pid} ${fact.pgid}\n`, fact.pgid))
    yield* model("parse", () => parseStatus(`${fact.exitStatus}\n`))
    yield* Effect.scoped(Effect.gen(function*() {
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-binary-smoke-" })
      const home = path.join(dataDir, "default-sentinel")
      const project = path.join(dataDir, "project")
      yield* fs.makeDirectory(home, { recursive: true })
      yield* fs.makeDirectory(project, { recursive: true })
      const health = yield* runCommand(root, "./dist/expand", ["--data-dir", dataDir, "health", "--format", "json"], {
        HOME: home,
        EXPAND_BACKEND_CMD: undefined
      }).pipe(Effect.flatMap((report) => requireSuccess(report, "auto-spawn health")))
      yield* decodeOutput(Health, health.stdout, "health")
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
      yield* decodeOutput(JsonValue, deletedSource, "delete")
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
