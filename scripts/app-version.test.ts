import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { processSpawnerFixture } from "../test/support/process-spawner"
import {
  AppVersionError,
  resolveAppVersion,
  resolveBuildAppVersion,
  resolveAppVersionObservation
} from "./app-version"

describe("app version observation", () => {
  it.effect.each([
    [{ exactTags: ["v1.2.3"], shortSha: "0123456789ab" }, "release", "1.2.3"],
    [{ exactTags: ["v1.2.3-rc.1"], shortSha: "0123456789ab" }, "release", "1.2.3-rc.1"],
    [{ exactTags: ["v1.2.3+build.5"], shortSha: undefined }, "release", "1.2.3+build.5"],
    [{ exactTags: ["v1.2.3-alpha+001"], shortSha: undefined }, "release", "1.2.3-alpha+001"],
    [{ exactTags: [], shortSha: "0123456789ab" }, "development", "0.0.0-dev+0123456789ab"],
    [{ exactTags: [], shortSha: undefined }, "development", "0.0.0-dev"]
  ] as const)("resolves %j in %s mode", ([observation, mode, expected]) =>
    resolveAppVersionObservation(observation, mode).pipe(
      Effect.map((actual) => expect(actual).toBe(expected))
    ))

  it.effect.each([
    [{ exactTags: ["v01.2.3"], shortSha: "0123456789ab" }, "invalid-release-tag"],
    [{ exactTags: ["v1.2"], shortSha: "0123456789ab" }, "invalid-release-tag"],
    [{ exactTags: ["release-1.2.3"], shortSha: "0123456789ab" }, "invalid-release-tag"],
    [{ exactTags: ["v1.2.3-01"], shortSha: undefined }, "invalid-release-tag"],
    [{ exactTags: ["v1.2.3-alpha..1"], shortSha: undefined }, "invalid-release-tag"],
    [{ exactTags: ["v1.2.3+build..5"], shortSha: undefined }, "invalid-release-tag"],
    [{ exactTags: ["v1.2.3", "v2.0.0"], shortSha: "0123456789ab" }, "conflicting-release-tags"],
    [{ exactTags: [], shortSha: "0123456789ab" }, "missing-release-tag"]
  ] as const)("rejects %j in release mode with %s", ([observation, reason]) =>
    resolveAppVersionObservation(observation, "release").pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toEqual(expect.objectContaining({ _tag: "AppVersionError", reason })))
    ))

  it.effect.each(["short", "0123456789az"])("rejects invalid development SHA %s", (shortSha) =>
    resolveAppVersionObservation({ exactTags: [], shortSha }, "development").pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toEqual(expect.objectContaining({ reason: "invalid-sha" })))
    ))
})

describe("app version Git adapter", () => {
  const commandDetails = (fixture: ReturnType<typeof processSpawnerFixture>) => fixture.records.map(({ command, released }) => {
    expect(command._tag).toBe("StandardCommand")
    return command._tag === "StandardCommand"
      ? { command: command.command, args: command.args, cwd: command.options.cwd, released }
      : undefined
  })

  it.effect("release mode probes only exact product tags and releases the probe", () => {
    const git = processSpawnerFixture([0], { stdout: ["v1.2.3\n"] })
    return resolveAppVersion("/repo", "release").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => {
        expect(version).toBe("1.2.3")
        expect(commandDetails(git)).toEqual([
          { command: "git", args: ["tag", "--points-at", "HEAD", "--list", "v*"], cwd: "/repo", released: true }
        ])
      })
    )
  })

  it.effect("development mode probes only the SHA and releases the probe", () => {
    const git = processSpawnerFixture([0], { stdout: ["0123456789ab\n"] })
    return resolveAppVersion("/repo", "development").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => {
        expect(version).toBe("0.0.0-dev+0123456789ab")
        expect(commandDetails(git)).toEqual([
          { command: "git", args: ["rev-parse", "--short=12", "HEAD"], cwd: "/repo", released: true }
        ])
      })
    )
  })

  it.effect("falls back without Git metadata in development mode and releases the failed probe", () => {
    const git = processSpawnerFixture([128], { stderr: ["not a repository"] })
    return resolveAppVersion("/repo", "development").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => {
        expect(version).toBe("0.0.0-dev")
        expect(git.records[0]?.released).toBe(true)
      })
    )
  })

  it.effect("reports release tag probe failures and releases the failed probe", () => {
    const git = processSpawnerFixture([128], { stderr: ["not a repository"] })
    return resolveAppVersion("/repo", "release").pipe(
      Effect.provide(git.layer),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toEqual(expect.objectContaining({
          _tag: "AppVersionError",
          reason: "git-probe",
          detail: expect.stringContaining("not a repository")
        }))
        expect(git.records[0]?.released).toBe(true)
      })
    )
  })

  it.effect("uses an exact valid tag for build identity without probing the SHA", () => {
    const git = processSpawnerFixture([0], { stdout: ["v2.3.4\n"] })
    return resolveBuildAppVersion("/repo").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => {
        expect(version).toBe("2.3.4")
        expect(commandDetails(git)).toEqual([
          { command: "git", args: ["tag", "--points-at", "HEAD", "--list", "v*"], cwd: "/repo", released: true }
        ])
      })
    )
  })

  it.effect("uses the SHA development identity for an untagged build and releases both probes", () => {
    const git = processSpawnerFixture([0, 0], { stdout: ["", "abcdef012345\n"] })
    return resolveBuildAppVersion("/repo").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => {
        expect(version).toBe("0.0.0-dev+abcdef012345")
        expect(commandDetails(git)).toEqual([
          { command: "git", args: ["tag", "--points-at", "HEAD", "--list", "v*"], cwd: "/repo", released: true },
          { command: "git", args: ["rev-parse", "--short=12", "HEAD"], cwd: "/repo", released: true }
        ])
      })
    )
  })

  it.effect("fails a build closed for malformed or conflicting product tags without probing the SHA", () => {
    const malformed = processSpawnerFixture([0], { stdout: ["v1.2.3-01\n"] })
    const conflicting = processSpawnerFixture([0], { stdout: ["v1.2.3\nv2.0.0\n"] })
    return Effect.gen(function*() {
      const malformedError = yield* resolveBuildAppVersion("/repo").pipe(Effect.provide(malformed.layer), Effect.flip)
      expect(malformedError).toEqual(expect.objectContaining({ reason: "invalid-release-tag" }))
      expect(malformed.records).toHaveLength(1)
      expect(malformed.records[0]?.released).toBe(true)

      const conflictingError = yield* resolveBuildAppVersion("/repo").pipe(Effect.provide(conflicting.layer), Effect.flip)
      expect(conflictingError).toEqual(expect.objectContaining({ reason: "conflicting-release-tags" }))
      expect(conflicting.records).toHaveLength(1)
      expect(conflicting.records[0]?.released).toBe(true)
    })
  })

  it.effect("falls back to an unqualified development identity when an untagged build cannot probe the SHA", () => {
    const git = processSpawnerFixture([0, 128], { stdout: [""], stderr: ["", "not a repository"] })
    return resolveBuildAppVersion("/repo").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => {
        expect(version).toBe("0.0.0-dev")
        expect(git.records.every(({ released }) => released)).toBe(true)
      })
    )
  })

  it("exports the tagged error type", () => {
    expect(new AppVersionError({ reason: "missing-release-tag", detail: "missing" })._tag).toBe("AppVersionError")
  })
})
