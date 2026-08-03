import { it } from "@effect/vitest"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect } from "vitest"
import {
  AppVersionError,
  resolveAppVersion,
  resolveAppVersionObservation
} from "./app-version"

describe("app version observation", () => {
  it.effect.each([
    [{ exactTags: ["v1.2.3"], shortSha: "0123456789ab" }, "release", "1.2.3"],
    [{ exactTags: ["v1.2.3-rc.1"], shortSha: "0123456789ab" }, "release", "1.2.3-rc.1"],
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
  const fixture = (results: ReadonlyArray<{ readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }>) => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd: string | undefined }> = []
    let index = 0
    const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => {
      expect(command._tag).toBe("StandardCommand")
      if (command._tag !== "StandardCommand") return Effect.die("expected standard command")
      commands.push({ command: command.command, args: command.args, cwd: command.options.cwd })
      const result = results[index++] ?? { exitCode: 0 }
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(index),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(result.stdout ?? "").pipe(Stream.encodeText),
        stderr: Stream.make(result.stderr ?? "").pipe(Stream.encodeText),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      }))
    }))
    return { commands, layer }
  }

  it.effect("runs exact tag and twelve-character SHA probes, trims output, and excludes unrelated tags", () => {
    const git = fixture([
      { exitCode: 0, stdout: "v1.2.3\n" },
      { exitCode: 0, stdout: "0123456789ab\n" }
    ])
    return resolveAppVersion("/repo", "release").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => {
        expect(version).toBe("1.2.3")
        expect(git.commands).toEqual([
          { command: "git", args: ["tag", "--points-at", "HEAD", "--list", "v*"], cwd: "/repo" },
          { command: "git", args: ["rev-parse", "--short=12", "HEAD"], cwd: "/repo" }
        ])
      })
    )
  })

  it.effect("falls back without Git metadata in development mode", () => {
    const git = fixture([{ exitCode: 128, stderr: "not a repository" }])
    return resolveAppVersion("/repo", "development").pipe(
      Effect.provide(git.layer),
      Effect.map((version) => expect(version).toBe("0.0.0-dev"))
    )
  })

  it.effect("reports Git probe failures in release mode", () => {
    const git = fixture([{ exitCode: 128, stderr: "not a repository" }])
    return resolveAppVersion("/repo", "release").pipe(
      Effect.provide(git.layer),
      Effect.flip,
      Effect.map((error) => expect(error).toEqual(expect.objectContaining({
        _tag: "AppVersionError",
        reason: "git-probe",
        detail: expect.stringContaining("not a repository")
      })))
    )
  })

  it("exports the tagged error type", () => {
    expect(new AppVersionError({ reason: "missing-release-tag", detail: "missing" })._tag).toBe("AppVersionError")
  })
})
