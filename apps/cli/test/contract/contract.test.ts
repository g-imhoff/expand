import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { makeTempDirectoryScoped, writeFixture } from "../../../../test/support/effect-files"
import { makeExpand } from "@expand/cli/main"
import { AppContext, defaultDataDir } from "@expand/contracts/app-context"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { ServerClient, type ServerClientApi } from "@expand/client-ts/server"
import { runCli, stubLayer } from "../harness"

// The backend validates names/tags at its ingestion boundary and returns a typed
// ProjectInvalidInput; these stubs mirror that so the CLI's INVALID_ARGUMENT
// mapping (exit 2) is exercised without a real server.
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Any))

const KEBAB = /^[a-z0-9][a-z0-9-]{0,63}$/
const invalidInput = (field: string) => Effect.fail({ _tag: "ProjectInvalidInput", field, reason: `invalid ${field}` })

const FULL = (over: Partial<{ id: string; name: string; directory: string | null; description: string | null; tags: ReadonlyArray<string>; archived: boolean }>) => ({
  id: over.id ?? "01J", name: over.name ?? "alpha", directory: over.directory ?? null, description: over.description ?? null,
  tags: over.tags ?? [], archived: over.archived ?? false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
})

const UUID = "11111111-1111-4111-8111-111111111111"
const cdClient = {
  ProjectList: () => Effect.succeed({ projects: [FULL({ id: UUID, name: "alpha" })], seq: 0 }),
  ProjectChangeDirectory: ({ id, directory }: { id: string; directory: string }) =>
    directory === "/bad"
      ? Effect.fail({ _tag: "ProjectDirectoryInvalid", directory, reason: "not-found" })
      : directory === "/dup"
        ? Effect.fail({ _tag: "ProjectDirectoryConflict", directory })
        : Effect.succeed(FULL({ id, name: "alpha", directory }))
}

const okClient = {
  Health: () => Effect.succeed("ok"),
  ProjectCreate: ({ name, ensure }: { name: string; ensure: boolean }) =>
    !KEBAB.test(name)
      ? invalidInput("name")
      : name === "dup" && !ensure
        ? Effect.fail({ _tag: "ProjectAlreadyExists", name })
        : Effect.succeed({ created: !(name === "dup"), project: { id: "01J", name, createdAt: "2026-01-01T00:00:00.000Z" } }),
  ProjectList: () => Effect.succeed({
    projects: [
      FULL({ id: "01K", name: "beta" }),
      FULL({ id: "01J", name: "alpha" })
    ],
    seq: 0
  }),
  ProjectRename: ({ id, name }: { id: string; name: string }) =>
    name === "taken"
      ? Effect.fail({ _tag: "ProjectNameConflict", name })
      : id === "00000000-0000-4000-8000-000000000000" || id === "01J"
        ? Effect.succeed(FULL({ id, name }))
        : Effect.fail({ _tag: "ProjectNotFound", id }),
  ProjectArchive: ({ id }: { id: string }) =>
    Effect.succeed(FULL({ id, name: "alpha", archived: true })),
  ProjectRestore: ({ id }: { id: string }) =>
    Effect.succeed(FULL({ id, name: "alpha", archived: false })),
  ProjectDelete: ({ id }: { id: string }) =>
    Effect.succeed({ id, deleted: true })
}
const downClient = {
  Health: () => Effect.fail({ _tag: "BackendUnavailable", reason: "no server" }),
  ProjectCreate: () => Effect.fail({ _tag: "BackendUnavailable", reason: "no server" }),
  ProjectList: () => Effect.fail({ _tag: "BackendUnavailable", reason: "no server" })
}
const tree = (stub: object) => makeExpand(stubLayer(stub))
const contextTree = () => makeExpand(
  Layer.mergeAll(
    Layer.succeed(ProjectClient, {} as ProjectClientApi),
    Layer.effect(
      ServerClient,
      Effect.map(AppContext, ({ paths }): ServerClientApi => ({
        health: () => Schema.encodeEffect(Schema.UnknownFromJsonString)(paths).pipe(Effect.orDie)
      }))
    )
  )
)

describe("CLI contract", () => {
  it.live("shows --data-dir in root and subcommand help", () => Effect.gen(function*() {
    const root = yield* runCli(tree(okClient), ["--help"])
    const child = yield* runCli(tree(okClient), ["health", "--help"])
    expect(root.code).toBe(0)
    expect(child.code).toBe(0)
    expect(root.stdout.join("\n")).toContain("--data-dir")
    expect(child.stdout.join("\n")).toContain("--data-dir")
  }))

  it.live.each([
    { position: "before", argv: ["--data-dir", "agent-state", "health"] },
    { position: "after", argv: ["health", "--data-dir", "agent-state"] }
  ])("accepts --data-dir $position the selected subcommand and resolves it", ({ argv }) => Effect.gen(function*() {
    const r = yield* runCli(contextTree(), argv)
    const envelope = (yield* parseJson(r.stdout.join("")))
    const paths = (yield* parseJson(envelope.data.status))
    const path = yield* Path.Path
    const expected = path.resolve("agent-state")
    expect(r.code).toBe(0)
    expect(paths).toEqual({
      dataDir: expected,
      dbPath: path.join(expected, "events.db"),
      endpointFile: path.join(expected, "server.json"),
      spawnLockFile: path.join(expected, "server.json.lock"),
      logDir: path.join(expected, "logs")
    })
  }).pipe(Effect.provide(NodeServices.layer)))

  it.live("uses the channel default when --data-dir is omitted", () => Effect.gen(function*() {
    const r = yield* runCli(contextTree(), ["health"])
    const envelope = (yield* parseJson(r.stdout.join("")))
    expect((yield* parseJson(envelope.data.status)).dataDir).toContain(defaultDataDir(yield* Path.Path, ""))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.live("accepts an existing directory and a path that does not exist", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* makeTempDirectoryScoped("expand-data-dir-")
      const existing = path.join(root, "existing")
      const absent = path.join(root, "absent")
      yield* fs.makeDirectory(existing)
      const existingResult = yield* runCli(contextTree(), ["health", "--data-dir", existing])
      const absentResult = yield* runCli(contextTree(), ["health", "--data-dir", absent])
      expect(existingResult.code).toBe(0)
      expect(absentResult.code).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("rejects an existing file before the handler runs", () =>
    Effect.gen(function*() {
      const root = yield* makeTempDirectoryScoped("expand-data-dir-")
      const file = yield* writeFixture(root, "not-a-directory", "x")
      const r = yield* runCli(contextTree(), ["health", "--data-dir", file])
      expect(r.code).toBe(2)
      expect(r.stdout).toEqual([])
      expect((yield* parseJson(r.stderr.join("")))).toMatchObject({
        kind: "Error",
        code: "INVALID_ARGUMENT"
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("project create -> Project envelope, exit 0, stdout pure JSON, stderr empty", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "create", "foo"])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "Project", created: true, data: { name: "foo" } })
  }))
  it.live("project create --quiet -> bare id", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "create", "foo", "--quiet"])
    expect(r.stdout.join("")).toBe("01J"); expect(r.code).toBe(0)
  }))
  it.live("project create --format text -> human line", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "create", "foo", "--format", "text"])
    expect(r.stdout.join("")).toContain("foo")
  }))
  it.live("project create --directory passes the directory through to ProjectCreate", () => Effect.gen(function*() {
    const dirClient = {
      ProjectCreate: ({ name, directory }: { name: string; ensure: boolean; directory?: string | null }) =>
        Effect.succeed({ created: true, project: { id: "01J", name, directory: directory ?? null, createdAt: "2026-01-01T00:00:00.000Z" } })
    }
    const r = yield* runCli(tree(dirClient), ["project", "create", "foo", "--directory", "/srv/foo"])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "Project", created: true, data: { name: "foo", directory: "/srv/foo" } })
  }))
  it.live("project create dup -> PROJECT_EXISTS on stderr, stdout empty, exit 5", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "create", "dup"])
    expect(r.stdout).toEqual([])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "PROJECT_EXISTS", retryable: false })
    expect(r.code).toBe(5)
  }))
  it.live("project create dup --ensure -> created:false, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "create", "dup", "--ensure"])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ created: false })
    expect(r.code).toBe(0)
  }))
  it.live("project create 'My Proj' -> INVALID_ARGUMENT on stderr, exit 2 (server-validated)", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "create", "My Proj"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  }))
  it.live("backend unreachable -> BACKEND_UNREACHABLE, retryable, exit 6", () => Effect.gen(function*() {
    const r = yield* runCli(tree(downClient), ["health"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ code: "BACKEND_UNREACHABLE", retryable: true })
    expect(r.code).toBe(6)
  }))
  it.live("project list -> ProjectList envelope, count, stable (createdAt,id) order", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "list"])
    const env = (yield* parseJson(r.stdout.join("")))
    expect(env).toMatchObject({ kind: "ProjectList", count: 2 })
    expect(env.data.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta"])
  }))
  it.live("project list --archived passes includeArchived:true (shows archived projects)", () => Effect.gen(function*() {
    const listClient = {
      ProjectList: ({ includeArchived }: { includeArchived?: boolean } = {}) =>
        Effect.succeed({
          projects: includeArchived
            ? [FULL({ id: "01J", name: "alpha" }), FULL({ id: "01K", name: "beta", archived: true })]
            : [FULL({ id: "01J", name: "alpha" })],
          seq: 0
        })
    }
    const def = yield* runCli(tree(listClient), ["project", "list"])
    expect((yield* parseJson(def.stdout.join(""))).count).toBe(1)
    const arch = yield* runCli(tree(listClient), ["project", "list", "--archived"])
    expect((yield* parseJson(arch.stdout.join(""))).count).toBe(2)
    const all = yield* runCli(tree(listClient), ["project", "list", "--all"])
    expect((yield* parseJson(all.stdout.join(""))).count).toBe(2)
  }))
  it.live("health -> ServerHealth envelope", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["health"])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "ServerHealth", data: { status: "ok" } })
    expect(r.code).toBe(0)
  }))
  it.live("project rename <uuid> <new> -> Project envelope created:false, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "rename", "00000000-0000-4000-8000-000000000000", "renamed"])
    expect(r.code).toBe(0)
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "Project", created: false, data: { name: "renamed" } })
  }))
  it.live("project rename <name> <new> resolves via ProjectList, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "rename", "alpha", "renamed"])
    expect(r.code).toBe(0)
    expect((yield* parseJson(r.stdout.join(""))).data.id).toBe("01J")
  }))
  it.live("project rename to a taken name -> NAME_CONFLICT, exit 8", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "rename", "alpha", "taken"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "NAME_CONFLICT", retryable: false })
    expect(r.code).toBe(8)
  }))
  it.live("project rename of unknown name -> PROJECT_NOT_FOUND, exit 7", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "rename", "ghost", "x"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND" })
    expect(r.code).toBe(7)
  }))
  it.live("project change-directory by name -> Project envelope created:false, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(cdClient), ["project", "change-directory", "alpha", "/srv/alpha"])
    expect(r.code).toBe(0)
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "Project", created: false, data: { directory: "/srv/alpha" } })
  }))
  it.live("project change-directory by uuid -> resolves without ProjectList", () => Effect.gen(function*() {
    const r = yield* runCli(tree({ ProjectChangeDirectory: cdClient.ProjectChangeDirectory }), ["project", "change-directory", UUID, "/srv/x"])
    expect(r.code).toBe(0)
  }))
  it.live("project change-directory invalid dir -> DIRECTORY_INVALID exit 9", () => Effect.gen(function*() {
    const r = yield* runCli(tree(cdClient), ["project", "change-directory", "alpha", "/bad"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "DIRECTORY_INVALID", retryable: false })
    expect(r.code).toBe(9)
  }))
  it.live("project change-directory conflicting dir -> DIRECTORY_CONFLICT exit 10", () => Effect.gen(function*() {
    const r = yield* runCli(tree(cdClient), ["project", "change-directory", "alpha", "/dup"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "DIRECTORY_CONFLICT", retryable: false })
    expect(r.code).toBe(10)
  }))
  it.live("project archive <uuid> -> Project envelope created:false, archived:true, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "archive", "00000000-0000-4000-8000-000000000000"])
    expect(r.code).toBe(0)
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "Project", created: false, data: { archived: true } })
  }))
  it.live("project restore <uuid> -> Project envelope archived:false", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "restore", "00000000-0000-4000-8000-000000000000"])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "Project", created: false, data: { archived: false } })
  }))
  it.live("project archive alpha (name target) resolves via ProjectList then archives", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "archive", "alpha"])
    expect(r.code).toBe(0)
    expect((yield* parseJson(r.stdout.join(""))).data.archived).toBe(true)
  }))
  it.live("project archive missing -> PROJECT_NOT_FOUND on stderr, exit 7", () => Effect.gen(function*() {
    const notFound = { ...okClient, ProjectList: () => Effect.succeed({ projects: [], seq: 0 }),
      ProjectArchive: ({ id }: { id: string }) => Effect.fail({ _tag: "ProjectNotFound", id }) }
    const r = yield* runCli(tree(notFound), ["project", "archive", "00000000-0000-4000-8000-000000000000"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND" })
    expect(r.code).toBe(7)
  }))
  const metaClient = {
    ...okClient,
    ProjectList: () => Effect.succeed({ projects: [FULL({ id: "01J", name: "alpha" })], seq: 0 }),
    ProjectSetMetadata: ({ id, description, tags }: { id: string; description?: string | null; tags?: ReadonlyArray<string> }) =>
      tags !== undefined && tags.some((t) => !KEBAB.test(t))
        ? invalidInput("tags")
        : Effect.succeed(FULL({ id, name: "alpha", description: description ?? null, tags: tags ?? [] }))
  }

  it.live("project set-metadata <name> --description --tag -> Project envelope created:false, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--description", "hi", "--tag", "x", "--tag", "y"])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "Project", created: false, data: { id: "01J", description: "hi", tags: ["x", "y"] } })
  }))

  it.live("project set-metadata --clear-tags -> empty tags", () => Effect.gen(function*() {
    const r = yield* runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--clear-tags"])
    expect((yield* parseJson(r.stdout.join(""))).data.tags).toEqual([])
    expect(r.code).toBe(0)
  }))

  it.live("project set-metadata --quiet -> bare id", () => Effect.gen(function*() {
    const r = yield* runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--description", "hi", "--quiet"])
    expect(r.stdout.join("")).toBe("01J"); expect(r.code).toBe(0)
  }))

  it.live("project set-metadata unknown -> PROJECT_NOT_FOUND, exit 7", () => Effect.gen(function*() {
    const notFound = {
      ...metaClient,
      ProjectList: () => Effect.succeed({ projects: [], seq: 0 })
    }
    const r = yield* runCli(tree(notFound), ["project", "set-metadata", "ghost", "--description", "x"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND" })
    expect(r.code).toBe(7)
  }))

  it.live("project set-metadata --tag 'BAD TAG' -> INVALID_ARGUMENT on stderr, exit 2 (server-validated)", () => Effect.gen(function*() {
    const r = yield* runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--tag", "BAD TAG"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  }))

  it.live("project delete <uuid> -> ProjectDelete envelope, exit 0", () => Effect.gen(function*() {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    const stub = { ...okClient, ProjectDelete: ({ id }: { id: string }) => Effect.succeed({ id, deleted: true }) }
    const r = yield* runCli(tree(stub), ["project", "delete", uuid])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "ProjectDelete", data: { id: uuid, deleted: true } })
  }))
  it.live("project delete <name> -> resolves via ProjectList then deletes, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "delete", "alpha"])
    expect(r.code).toBe(0)
    expect((yield* parseJson(r.stdout.join(""))).data.deleted).toBe(true)
  }))
  it.live("project delete <unknown name> -> PROJECT_NOT_FOUND on stderr, exit 7", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["project", "delete", "ghost"])
    expect(r.stdout).toEqual([])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND", retryable: false })
    expect(r.code).toBe(7)
  }))

})

describe("CLI parse/validation edge cases", () => {
  const opsClient = {
    ...okClient,
    ProjectList: () => Effect.succeed({ projects: [FULL({ id: "01J", name: "alpha" })], seq: 0 }),
    ProjectRename: ({ id, name }: { id: string; name: string }) =>
      name === "taken"
        ? Effect.fail({ _tag: "ProjectNameConflict", name })
        : Effect.succeed(FULL({ id, name })),
    ProjectChangeDirectory: ({ id, directory }: { id: string; directory: string }) =>
      directory === "/nope"
        ? Effect.fail({ _tag: "ProjectDirectoryInvalid", directory, reason: "not-found" })
        : Effect.succeed(FULL({ id, directory })),
    ProjectArchive: ({ id }: { id: string }) => Effect.succeed(FULL({ id })),
    ProjectRestore: ({ id }: { id: string }) => Effect.succeed(FULL({ id })),
    ProjectSetMetadata: ({ id }: { id: string }) => Effect.succeed(FULL({ id })),
    ProjectDelete: ({ id }: { id: string }) => Effect.succeed({ id, deleted: true })
  }
  const missingClient = {
    ...opsClient,
    ProjectList: () => Effect.succeed({ projects: [] as ReadonlyArray<ReturnType<typeof FULL>>, seq: 0 }),
    ProjectRename: ({ id }: { id: string }) => Effect.fail({ _tag: "ProjectNotFound", id })
  }

  it.live("over-length name (>64 chars) -> INVALID_ARGUMENT, exit 2 (server-validated)", () => Effect.gen(function*() {
    const long = "a".repeat(65)
    const r = yield* runCli(tree(opsClient), ["project", "create", long])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  }))
  it.live("uppercase/illegal name -> INVALID_ARGUMENT, exit 2", () => Effect.gen(function*() {
    const r = yield* runCli(tree(opsClient), ["project", "create", "BadName"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  }))
  it.live("empty name -> INVALID_ARGUMENT, exit 2", () => Effect.gen(function*() {
    const r = yield* runCli(tree(opsClient), ["project", "create", ""])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  }))
  it.live("rename missing the new-name arg -> INVALID_ARGUMENT, exit 2", () => Effect.gen(function*() {
    const r = yield* runCli(tree(opsClient), ["project", "rename", "alpha"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  }))
  it.live("rename a name that resolves but server reports name conflict -> NAME_CONFLICT, exit 8", () => Effect.gen(function*() {
    const r = yield* runCli(tree(opsClient), ["project", "rename", "alpha", "taken"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ kind: "Error", code: "NAME_CONFLICT", retryable: false })
    expect(r.code).toBe(8)
  }))
  it.live("change-directory to a non-existent path -> DIRECTORY_INVALID, exit 9", () => Effect.gen(function*() {
    const r = yield* runCli(tree(opsClient), ["project", "change-directory", "alpha", "/nope"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ code: "DIRECTORY_INVALID", retryable: false })
    expect(r.code).toBe(9)
  }))
  it.live("rename a name not in the list -> PROJECT_NOT_FOUND, exit 7 (resolveProjectTarget)", () => Effect.gen(function*() {
    const r = yield* runCli(tree(missingClient), ["project", "rename", "ghost", "newname"])
    expect((yield* parseJson(r.stderr.join("")))).toMatchObject({ code: "PROJECT_NOT_FOUND", retryable: false })
    expect(r.code).toBe(7)
  }))
  it.live("delete by UUID target skips the list lookup and returns ProjectDelete envelope, exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(opsClient), ["project", "delete", "11111111-1111-4111-8111-111111111111"])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "ProjectDelete", data: { deleted: true } })
    expect(r.code).toBe(0)
  }))
  it.live("list --archived passes includeArchived (still ProjectList envelope), exit 0", () => Effect.gen(function*() {
    const r = yield* runCli(tree(opsClient), ["project", "list", "--archived"])
    expect((yield* parseJson(r.stdout.join("")))).toMatchObject({ kind: "ProjectList" })
    expect(r.code).toBe(0)
  }))
})

describe("CLI help (#3)", () => {
  it.live("health --help explains it is a backend reachability probe", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["health", "--help"])
    const out = r.stdout.join("\n")
    expect(out).toContain("check that a Expand backend is reachable")
  }))

  it.live("expand --help lists health with its description", () => Effect.gen(function*() {
    const r = yield* runCli(tree(okClient), ["--help"])
    const out = r.stdout.join("\n")
    expect(out).toMatch(/health\s+check that a Expand backend is reachable/)
  }))
})
