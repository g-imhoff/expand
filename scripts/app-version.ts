import { Data, Effect, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type AppVersionMode = "development" | "release"

export interface AppVersionObservation {
  readonly exactTags: ReadonlyArray<string>
  readonly shortSha: string | undefined
}

export class AppVersionError extends Data.TaggedError("AppVersionError")<{
  readonly reason: "git-probe" | "missing-release-tag" | "conflicting-release-tags" | "invalid-release-tag" | "invalid-sha"
  readonly detail: string
  readonly cause?: unknown
}> {}

const numericIdentifier = "(?:0|[1-9][0-9]*)"
const nonNumericIdentifier = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`
const semver = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

export const resolveAppVersionObservation = Effect.fn("AppVersion.resolveObservation")(
  function*(observation: AppVersionObservation, mode: AppVersionMode) {
    if (mode === "development") {
      if (observation.shortSha === undefined) return "0.0.0-dev"
      if (!/^[0-9a-f]{12}$/.test(observation.shortSha)) {
        return yield* new AppVersionError({ reason: "invalid-sha", detail: `invalid short SHA: ${observation.shortSha}` })
      }
      return `0.0.0-dev+${observation.shortSha}`
    }
    if (observation.exactTags.length === 0) {
      return yield* new AppVersionError({ reason: "missing-release-tag", detail: "HEAD has no exact release tag" })
    }
    if (observation.exactTags.length > 1) {
      return yield* new AppVersionError({ reason: "conflicting-release-tags", detail: `HEAD has conflicting release tags: ${observation.exactTags.join(", ")}` })
    }
    const tag = observation.exactTags[0]!
    const version = tag.startsWith("v") ? tag.slice(1) : ""
    if (!semver.test(version)) {
      return yield* new AppVersionError({ reason: "invalid-release-tag", detail: `invalid release tag: ${tag}` })
    }
    return version
  }
)

const gitProbe = Effect.fn("AppVersion.gitProbe")(
  (root: string, args: ReadonlyArray<string>) => Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: root })).pipe(
      Effect.mapError((cause) => new AppVersionError({ reason: "git-probe", detail: `git ${args.join(" ")} could not start`, cause }))
    )
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" }).pipe(
      Effect.mapError((cause) => new AppVersionError({ reason: "git-probe", detail: `git ${args.join(" ")} failed`, cause }))
    )
    if (exitCode !== 0) {
      const detail = stderr.trim()
      return yield* new AppVersionError({
        reason: "git-probe",
        detail: detail.length === 0 ? `git ${args.join(" ")} exited ${exitCode}` : `git ${args.join(" ")} exited ${exitCode}: ${detail}`
      })
    }
    return stdout.trim()
  }))
)

const exactTags = (root: string) => gitProbe(root, ["tag", "--points-at", "HEAD", "--list", "v*"]).pipe(
  Effect.map((output) => output === "" ? [] : output.split("\n").map((tag) => tag.trim()).filter((tag) => tag !== ""))
)

const shortSha = (root: string) => gitProbe(root, ["rev-parse", "--short=12", "HEAD"]).pipe(
  Effect.map((output) => output === "" ? undefined : output)
)

export const resolveAppVersion = Effect.fn("AppVersion.resolve")(
  function*(root: string, mode: AppVersionMode) {
    if (mode === "release") {
      const tags = yield* exactTags(root)
      return yield* resolveAppVersionObservation({ exactTags: tags, shortSha: undefined }, "release")
    }
    const sha = Option.getOrUndefined(yield* Effect.option(shortSha(root)))
    return yield* resolveAppVersionObservation({ exactTags: [], shortSha: sha }, "development")
  }
)

export const resolveBuildAppVersion = Effect.fn("AppVersion.resolveBuild")(
  function*(root: string) {
    const observedTags = yield* Effect.option(exactTags(root))
    if (Option.isNone(observedTags)) return "0.0.0-dev"
    const tags = observedTags.value
    if (tags.length > 0) {
      return yield* resolveAppVersionObservation({ exactTags: tags, shortSha: undefined }, "release")
    }
    const sha = Option.getOrUndefined(yield* Effect.option(shortSha(root)))
    return yield* resolveAppVersionObservation({ exactTags: [], shortSha: sha }, "development")
  }
)
