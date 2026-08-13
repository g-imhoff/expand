import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Data, Effect, Exit, FileSystem, Path, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { resolveAppVersion } from "../../../scripts/app-version"

export class PublishStageError extends Data.TaggedError("PublishStageError")<{
  readonly operation: "missing-dist" | "read-manifest" | "clean" | "mkdir" | "copy" | "write" | "commit"
  readonly cause: unknown
}> {}

export class PublishManifestError extends Data.TaggedError("PublishManifestError")<{
  readonly cause: unknown
}> {}

export class PublishCommandError extends Data.TaggedError("PublishCommandError")<{
  readonly command: string
  readonly exitCode: number
}> {}

export class PublishProcessError extends Data.TaggedError("PublishProcessError")<{
  readonly command: string
  readonly cause: unknown
}> {}

export const build = Effect.fn("ClientPublish.build")(
  function*(root: string) {
    yield* runCommand(root, "tsup", [])
    yield* runCommand(root, "tsc", ["-p", "tsconfig.build.json"])
  }
)

export const stage = Effect.fn("ClientPublish.stage")(
  function*(root: string, releaseVersion: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dist = path.join(root, "dist")
    const target = path.join(root, "dist-publish")
    const next = path.join(root, ".dist-publish.next")
    const previous = path.join(root, ".dist-publish.previous")
    const distExists = yield* fs.exists(dist).pipe(
      Effect.mapError((cause) => new PublishStageError({ operation: "missing-dist", cause }))
    )
    if (!distExists) {
      return yield* new PublishStageError({ operation: "missing-dist", cause: "dist not found" })
    }

    const manifestText = yield* fs.readFileString(path.join(root, "package.json")).pipe(
      Effect.mapError((cause) => new PublishStageError({ operation: "read-manifest", cause }))
    )
    const source = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(manifestText).pipe(
      Effect.mapError((cause) => new PublishManifestError({ cause }))
    )
    const publishManifest = {
      name: source.name,
      version: releaseVersion,
      type: source.type,
      sideEffects: source.sideEffects,
      private: false as const,
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js"
        },
        "./project": {
          types: "./dist/project/index.d.ts",
          import: "./dist/project/index.js",
          default: "./dist/project/index.js"
        },
        "./server": {
          types: "./dist/server/index.d.ts",
          import: "./dist/server/index.js",
          default: "./dist/server/index.js"
        },
        "./adapters/node": {
          types: "./dist/adapters/node.d.ts",
          import: "./dist/adapters/node.js",
          default: "./dist/adapters/node.js"
        },
        "./package.json": "./package.json"
      },
      files: ["dist"] as const,
      dependencies: { ...source.dependencies, "@expand/contracts": releaseVersion }
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PublishedManifest))(publishManifest).pipe(
      Effect.mapError((cause) => new PublishManifestError({ cause }))
    )

    const remove = (location: string) => fs.remove(location, { recursive: true, force: true }).pipe(
      Effect.mapError((cause) => new PublishStageError({ operation: "clean", cause }))
    )
    const attemptAll = (operations: ReadonlyArray<Effect.Effect<void, PublishStageError>>) =>
      Effect.gen(function*() {
        const failures: Array<Cause.Cause<PublishStageError>> = []
        for (const operation of operations) {
          const exit = yield* Effect.exit(operation)
          if (Exit.isFailure(exit)) failures.push(exit.cause)
        }
        if (failures.length > 0) {
          let combined = failures[0] as Cause.Cause<PublishStageError>
          for (const failure of failures.slice(1)) combined = Cause.combine(combined, failure)
          return yield* Effect.failCause(combined)
        }
      })
    let phase: "initial" | "stale-cleaned" | "backing-up" | "backed-up" | "promoting" | "promoted" = "initial"
    let hadTarget = false
    let ownsPrevious = false
    const cleanupArtifacts = () => attemptAll([
      remove(next),
      ...(ownsPrevious ? [remove(previous)] : [])
    ])
    const rollback = () => Effect.gen(function*() {
      const targetExists = yield* fs.exists(target).pipe(
        Effect.mapError((cause) => new PublishStageError({ operation: "commit", cause }))
      )
      const backupExists = phase === "backing-up" || ownsPrevious
        ? yield* fs.exists(previous).pipe(
          Effect.mapError((cause) => new PublishStageError({ operation: "commit", cause }))
        )
        : false
      const mayRestorePrevious = hadTarget && backupExists && (ownsPrevious || (phase === "backing-up" && !targetExists))
      yield* attemptAll([
        Effect.gen(function*() {
          if (mayRestorePrevious) {
            yield* remove(target)
            yield* fs.rename(previous, target).pipe(
              Effect.mapError((cause) => new PublishStageError({ operation: "commit", cause }))
            )
          } else if (!hadTarget && (phase === "promoting" || phase === "promoted")) {
            yield* remove(target)
          }
        }),
        remove(next),
        ...(mayRestorePrevious ? [remove(previous)] : [])
      ])
    })
    const transaction = Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      hadTarget = yield* fs.exists(target).pipe(
        Effect.mapError((cause) => new PublishStageError({ operation: "commit", cause }))
      )
      yield* restore(attemptAll([remove(next), remove(previous)]))
      phase = "stale-cleaned"
      yield* restore(fs.makeDirectory(next, { recursive: true }).pipe(
        Effect.mapError((cause) => new PublishStageError({ operation: "mkdir", cause }))
      ))
      yield* restore(fs.copy(dist, path.join(next, "dist")).pipe(
        Effect.mapError((cause) => new PublishStageError({ operation: "copy", cause }))
      ))
      yield* restore(fs.writeFileString(path.join(next, "package.json"), `${encoded}\n`).pipe(
        Effect.mapError((cause) => new PublishStageError({ operation: "write", cause }))
      ))
      if (hadTarget) {
        phase = "backing-up"
        yield* fs.rename(target, previous).pipe(
          Effect.mapError((cause) => new PublishStageError({ operation: "commit", cause }))
        )
        ownsPrevious = true
        phase = "backed-up"
        yield* restore(Effect.void)
      }
      phase = "promoting"
      yield* fs.rename(next, target).pipe(
        Effect.mapError((cause) => new PublishStageError({ operation: "commit", cause }))
      )
      yield* restore(Effect.void)
      phase = "promoted"
    }))

    yield* transaction.pipe(Effect.onExit((transactionExit) => {
      const finalizer = Exit.isFailure(transactionExit) && phase !== "promoted" ? rollback() : cleanupArtifacts()
      return Effect.exit(finalizer).pipe(Effect.flatMap((cleanupExit) => {
        if (Exit.isSuccess(cleanupExit)) return Effect.void
        return Effect.failCause(Exit.isFailure(transactionExit)
          ? Cause.combine(transactionExit.cause, cleanupExit.cause)
          : cleanupExit.cause)
      }))
    }))
    yield* Console.log(`[prepare-publish] staged ${source.name}@${releaseVersion} -> ${target}`)
  }
)

export const pack = Effect.fn("ClientPublish.pack")(
  function*(root: string, releaseVersion: string) {
    yield* build(root)
    yield* stage(root, releaseVersion)
    yield* runCommand(root, "npm", ["pack", "./dist-publish"])
  }
)

export const releaseAtRoot = Effect.fn("ClientPublish.releaseAtRoot")(function*(operation: typeof stage | typeof pack) {
  const path = yield* Path.Path
  const root = yield* packageRoot
  const repositoryRoot = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
  const releaseVersion = yield* resolveAppVersion(repositoryRoot, "release")
  yield* operation(root, releaseVersion)
})

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  type: Schema.Literal("module"),
  sideEffects: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  exports: Schema.Unknown,
  dependencies: Schema.Record(Schema.String, Schema.String)
})

const PublishedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  type: Schema.Literal("module"),
  sideEffects: Schema.Boolean,
  private: Schema.Literal(false),
  exports: Schema.Record(Schema.String, Schema.Unknown),
  files: Schema.Tuple([Schema.Literal("dist")]),
  dependencies: Schema.Record(Schema.String, Schema.String)
})

const runCommand = Effect.fn("ClientPublish.runCommand")(
  (root: string, command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })).pipe(Effect.mapError((cause) => new PublishProcessError({ command, cause })))
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => new PublishProcessError({ command, cause }))
      )
      if (exitCode !== 0) {
        return yield* new PublishCommandError({ command, exitCode })
      }
    }))
)

const packageRoot = Path.Path.pipe(Effect.flatMap((path) => path.fromFileUrl(new URL("../", import.meta.url))))

const command = Command.make("prepare-publish").pipe(Command.withSubcommands([
  Command.make("build", {}, () => packageRoot.pipe(Effect.flatMap(build))),
  Command.make("stage", {}, () => releaseAtRoot(stage)),
  Command.make("pack", {}, () => releaseAtRoot(pack))
]))

const program = Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer))

if (import.meta.main) {
  NodeRuntime["runMain"](program)
}
