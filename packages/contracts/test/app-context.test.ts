import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Option, Path } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import {
  AppContext,
  type AppContextShape,
  dataDirFromArgs,
  defaultDataDir,
  makeAppContext
} from "@expand/contracts/app-context"

const withPath = <A>(use: (path: Path.Path) => A) =>
  Effect.gen(function*() {
    return use(yield* Path.Path)
  }).pipe(Effect.provide(NodeServices.layer))

describe("AppContext", () => {
  it.effect("derives channel-specific default directories from explicit host inputs", () =>
    withPath((path) => {
      expect(defaultDataDir(path, "/home/test", "dev")).toBe("/home/test/.expand/expand-dev")
      expect(defaultDataDir(path, "/home/test", "release")).toBe("/home/test/.expand/expand")
    }))

  it.effect("derives every path from explicit host inputs", () =>
    withPath((path) => {
      expect(makeAppContext(path, {
        homeDir: "/home/test",
        cwd: "/work",
        dataDir: "state",
        channel: "dev"
      })).toEqual({
        channel: "dev",
        paths: {
          dataDir: "/work/state",
          dbPath: "/work/state/events.db",
          endpointFile: "/work/state/server.json",
          logDir: "/work/state/logs",
          spawnLockFile: "/work/state/server.json.lock"
        }
      })
    }))

  it.effect("resolves relative overrides against the supplied current directory", () =>
    withPath((path) => {
      expect(makeAppContext(path, {
        homeDir: "/home/test",
        cwd: "/work",
        dataDir: "relative-state"
      }).paths.dataDir).toBe("/work/relative-state")
    }))

  it.effect("preserves absolute overrides", () =>
    withPath((path) => {
      expect(makeAppContext(path, {
        homeDir: "/home/test",
        cwd: "/work",
        dataDir: "/var/lib/expand"
      }).paths.dataDir).toBe("/var/lib/expand")
    }))

  it.effect("uses the channel fallback when no override is supplied", () =>
    withPath((path) => {
      expect(makeAppContext(path, {
        homeDir: "/home/test",
        cwd: "/work",
        channel: "release"
      }).paths.dataDir).toBe("/home/test/.expand/expand")
    }))

  it.effect("uses external coordination locks for implicit and explicit-equal defaults", () =>
    withPath((path) => {
      for (const [selectedChannel, lockName] of [
        ["dev", "expand-dev.spawn.lock"],
        ["release", "expand.spawn.lock"]
      ] as const) {
        const fallback = defaultDataDir(path, "/home/test", selectedChannel)
        const implicit = makeAppContext(path, {
          homeDir: "/home/test",
          cwd: "/work",
          channel: selectedChannel
        })
        const explicit = makeAppContext(path, {
          homeDir: "/home/test",
          cwd: "/work",
          dataDir: fallback,
          channel: selectedChannel
        })

        expect(implicit.paths.spawnLockFile).toBe(`/home/test/.expand-locks/${lockName}`)
        expect(explicit.paths.spawnLockFile).toBe(`/home/test/.expand-locks/${lockName}`)
      }
    }))

  it("selects the first data-dir argument only when a following token exists", () => {
    expect(dataDirFromArgs(["project", "list", "--data-dir", "state", "--data-dir", "other"])).toBe("state")
    expect(dataDirFromArgs(["--data-dir", "--quiet"])).toBe("--quiet")
    expect(dataDirFromArgs(["project", "list"])).toBeUndefined()
    expect(dataDirFromArgs(["project", "list", "--data-dir"])).toBeUndefined()
  })

  it("requires AppContext in the Effect environment", () => {
    const appContextProgram = Effect.gen(function*() {
      return yield* AppContext
    })

    expectTypeOf(appContextProgram).toMatchTypeOf<
      Effect.Effect<AppContextShape, never, AppContext>
    >()
  })

  it.effect("has no ambient AppContext service", () =>
    Effect.serviceOption(AppContext).pipe(
      Effect.map((context) => expect(Option.isNone(context)).toBe(true))
    ))
})
