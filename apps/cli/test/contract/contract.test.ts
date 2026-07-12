import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { makeExpand } from "@expand/cli/main"
import { AppContext, defaultDataDir } from "@expand/contracts/app-context"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { ServerClient, type ServerClientApi } from "@expand/client-ts/server"
import { runCli, stubLayer } from "../harness"

// The backend validates names/tags at its ingestion boundary and returns a typed
// ProjectInvalidInput; these stubs mirror that so the CLI's INVALID_ARGUMENT
// mapping (exit 2) is exercised without a real server.
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
        health: () => Effect.succeed(JSON.stringify(paths))
      }))
    )
  )
)

describe("CLI contract", () => {
  it("shows --data-dir in root and subcommand help", async () => {
    const root = await runCli(tree(okClient), ["--help"])
    const child = await runCli(tree(okClient), ["health", "--help"])
    expect(root.code).toBe(0)
    expect(child.code).toBe(0)
    expect(root.stdout.join("\n")).toContain("--data-dir")
    expect(child.stdout.join("\n")).toContain("--data-dir")
  })

  it.each([
    { position: "before", argv: ["--data-dir", "agent-state", "health"] },
    { position: "after", argv: ["health", "--data-dir", "agent-state"] }
  ])("accepts --data-dir $position the selected subcommand and resolves it", async ({ argv }) => {
    const r = await runCli(contextTree(), argv)
    const envelope = JSON.parse(r.stdout.join(""))
    const paths = JSON.parse(envelope.data.status)
    const expected = resolve("agent-state")
    expect(r.code).toBe(0)
    expect(paths).toEqual({
      dataDir: expected,
      dbPath: join(expected, "events.db"),
      endpointFile: join(expected, "server.json"),
      spawnLockFile: join(expected, "server.json.lock"),
      logDir: join(expected, "logs")
    })
  })

  it("uses the channel default when --data-dir is omitted", async () => {
    const r = await runCli(contextTree(), ["health"])
    const envelope = JSON.parse(r.stdout.join(""))
    expect(JSON.parse(envelope.data.status).dataDir).toBe(defaultDataDir())
  })

  it("accepts an existing directory and a path that does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-data-dir-"))
    const existing = join(root, "existing")
    const absent = join(root, "absent")
    mkdirSync(existing)
    try {
      const existingResult = await runCli(contextTree(), ["health", "--data-dir", existing])
      const absentResult = await runCli(contextTree(), ["health", "--data-dir", absent])
      expect(existingResult.code).toBe(0)
      expect(absentResult.code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects an existing file before the handler runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-data-dir-"))
    const file = join(root, "not-a-directory")
    writeFileSync(file, "x")
    try {
      const r = await runCli(contextTree(), ["health", "--data-dir", file])
      expect(r.code).toBe(2)
      expect(r.stdout).toEqual([])
      expect(JSON.parse(r.stderr.join(""))).toMatchObject({
        kind: "Error",
        code: "INVALID_ARGUMENT"
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("project create -> Project envelope, exit 0, stdout pure JSON, stderr empty", async () => {
    const r = await runCli(tree(okClient), ["project", "create", "foo"])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Project", created: true, data: { name: "foo" } })
  })
  it("project create --quiet -> bare id", async () => {
    const r = await runCli(tree(okClient), ["project", "create", "foo", "--quiet"])
    expect(r.stdout.join("")).toBe("01J"); expect(r.code).toBe(0)
  })
  it("project create --format text -> human line", async () => {
    const r = await runCli(tree(okClient), ["project", "create", "foo", "--format", "text"])
    expect(r.stdout.join("")).toContain("foo")
  })
  it("project create --directory passes the directory through to ProjectCreate", async () => {
    const dirClient = {
      ProjectCreate: ({ name, directory }: { name: string; ensure: boolean; directory?: string | null }) =>
        Effect.succeed({ created: true, project: { id: "01J", name, directory: directory ?? null, createdAt: "2026-01-01T00:00:00.000Z" } })
    }
    const r = await runCli(tree(dirClient), ["project", "create", "foo", "--directory", "/srv/foo"])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Project", created: true, data: { name: "foo", directory: "/srv/foo" } })
  })
  it("project create dup -> PROJECT_EXISTS on stderr, stdout empty, exit 5", async () => {
    const r = await runCli(tree(okClient), ["project", "create", "dup"])
    expect(r.stdout).toEqual([])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "PROJECT_EXISTS", retryable: false })
    expect(r.code).toBe(5)
  })
  it("project create dup --ensure -> created:false, exit 0", async () => {
    const r = await runCli(tree(okClient), ["project", "create", "dup", "--ensure"])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ created: false })
    expect(r.code).toBe(0)
  })
  it("project create 'My Proj' -> INVALID_ARGUMENT on stderr, exit 2 (server-validated)", async () => {
    const r = await runCli(tree(okClient), ["project", "create", "My Proj"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  })
  it("backend unreachable -> BACKEND_UNREACHABLE, retryable, exit 6", async () => {
    const r = await runCli(tree(downClient), ["health"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ code: "BACKEND_UNREACHABLE", retryable: true })
    expect(r.code).toBe(6)
  })
  it("project list -> ProjectList envelope, count, stable (createdAt,id) order", async () => {
    const r = await runCli(tree(okClient), ["project", "list"])
    const env = JSON.parse(r.stdout.join(""))
    expect(env).toMatchObject({ kind: "ProjectList", count: 2 })
    expect(env.data.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta"])
  })
  it("project list --archived passes includeArchived:true (shows archived projects)", async () => {
    const listClient = {
      ProjectList: ({ includeArchived }: { includeArchived?: boolean } = {}) =>
        Effect.succeed({
          projects: includeArchived
            ? [FULL({ id: "01J", name: "alpha" }), FULL({ id: "01K", name: "beta", archived: true })]
            : [FULL({ id: "01J", name: "alpha" })],
          seq: 0
        })
    }
    const def = await runCli(tree(listClient), ["project", "list"])
    expect(JSON.parse(def.stdout.join("")).count).toBe(1)
    const arch = await runCli(tree(listClient), ["project", "list", "--archived"])
    expect(JSON.parse(arch.stdout.join("")).count).toBe(2)
    const all = await runCli(tree(listClient), ["project", "list", "--all"])
    expect(JSON.parse(all.stdout.join("")).count).toBe(2)
  })
  it("health -> ServerHealth envelope", async () => {
    const r = await runCli(tree(okClient), ["health"])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "ServerHealth", data: { status: "ok" } })
    expect(r.code).toBe(0)
  })
  it("project rename <uuid> <new> -> Project envelope created:false, exit 0", async () => {
    const r = await runCli(tree(okClient), ["project", "rename", "00000000-0000-4000-8000-000000000000", "renamed"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Project", created: false, data: { name: "renamed" } })
  })
  it("project rename <name> <new> resolves via ProjectList, exit 0", async () => {
    const r = await runCli(tree(okClient), ["project", "rename", "alpha", "renamed"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout.join("")).data.id).toBe("01J")
  })
  it("project rename to a taken name -> NAME_CONFLICT, exit 8", async () => {
    const r = await runCli(tree(okClient), ["project", "rename", "alpha", "taken"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "NAME_CONFLICT", retryable: false })
    expect(r.code).toBe(8)
  })
  it("project rename of unknown name -> PROJECT_NOT_FOUND, exit 7", async () => {
    const r = await runCli(tree(okClient), ["project", "rename", "ghost", "x"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND" })
    expect(r.code).toBe(7)
  })
  it("project change-directory by name -> Project envelope created:false, exit 0", async () => {
    const r = await runCli(tree(cdClient), ["project", "change-directory", "alpha", "/srv/alpha"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Project", created: false, data: { directory: "/srv/alpha" } })
  })
  it("project change-directory by uuid -> resolves without ProjectList", async () => {
    const r = await runCli(tree({ ProjectChangeDirectory: cdClient.ProjectChangeDirectory }), ["project", "change-directory", UUID, "/srv/x"])
    expect(r.code).toBe(0)
  })
  it("project change-directory invalid dir -> DIRECTORY_INVALID exit 9", async () => {
    const r = await runCli(tree(cdClient), ["project", "change-directory", "alpha", "/bad"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "DIRECTORY_INVALID", retryable: false })
    expect(r.code).toBe(9)
  })
  it("project change-directory conflicting dir -> DIRECTORY_CONFLICT exit 10", async () => {
    const r = await runCli(tree(cdClient), ["project", "change-directory", "alpha", "/dup"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "DIRECTORY_CONFLICT", retryable: false })
    expect(r.code).toBe(10)
  })
  it("project archive <uuid> -> Project envelope created:false, archived:true, exit 0", async () => {
    const r = await runCli(tree(okClient), ["project", "archive", "00000000-0000-4000-8000-000000000000"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Project", created: false, data: { archived: true } })
  })
  it("project restore <uuid> -> Project envelope archived:false", async () => {
    const r = await runCli(tree(okClient), ["project", "restore", "00000000-0000-4000-8000-000000000000"])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Project", created: false, data: { archived: false } })
  })
  it("project archive alpha (name target) resolves via ProjectList then archives", async () => {
    const r = await runCli(tree(okClient), ["project", "archive", "alpha"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout.join("")).data.archived).toBe(true)
  })
  it("project archive missing -> PROJECT_NOT_FOUND on stderr, exit 7", async () => {
    const notFound = { ...okClient, ProjectList: () => Effect.succeed({ projects: [], seq: 0 }),
      ProjectArchive: ({ id }: { id: string }) => Effect.fail({ _tag: "ProjectNotFound", id }) }
    const r = await runCli(tree(notFound), ["project", "archive", "00000000-0000-4000-8000-000000000000"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND" })
    expect(r.code).toBe(7)
  })
  const metaClient = {
    ...okClient,
    ProjectList: () => Effect.succeed({ projects: [FULL({ id: "01J", name: "alpha" })], seq: 0 }),
    ProjectSetMetadata: ({ id, description, tags }: { id: string; description?: string | null; tags?: ReadonlyArray<string> }) =>
      tags !== undefined && tags.some((t) => !KEBAB.test(t))
        ? invalidInput("tags")
        : Effect.succeed(FULL({ id, name: "alpha", description: description ?? null, tags: tags ?? [] }))
  }

  it("project set-metadata <name> --description --tag -> Project envelope created:false, exit 0", async () => {
    const r = await runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--description", "hi", "--tag", "x", "--tag", "y"])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Project", created: false, data: { id: "01J", description: "hi", tags: ["x", "y"] } })
  })

  it("project set-metadata --clear-tags -> empty tags", async () => {
    const r = await runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--clear-tags"])
    expect(JSON.parse(r.stdout.join("")).data.tags).toEqual([])
    expect(r.code).toBe(0)
  })

  it("project set-metadata --quiet -> bare id", async () => {
    const r = await runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--description", "hi", "--quiet"])
    expect(r.stdout.join("")).toBe("01J"); expect(r.code).toBe(0)
  })

  it("project set-metadata unknown -> PROJECT_NOT_FOUND, exit 7", async () => {
    const notFound = {
      ...metaClient,
      ProjectList: () => Effect.succeed({ projects: [], seq: 0 })
    }
    const r = await runCli(tree(notFound), ["project", "set-metadata", "ghost", "--description", "x"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND" })
    expect(r.code).toBe(7)
  })

  it("project set-metadata --tag 'BAD TAG' -> INVALID_ARGUMENT on stderr, exit 2 (server-validated)", async () => {
    const r = await runCli(tree(metaClient), ["project", "set-metadata", "alpha", "--tag", "BAD TAG"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  })

  it("project delete <uuid> -> ProjectDelete envelope, exit 0", async () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    const stub = { ...okClient, ProjectDelete: ({ id }: { id: string }) => Effect.succeed({ id, deleted: true }) }
    const r = await runCli(tree(stub), ["project", "delete", uuid])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "ProjectDelete", data: { id: uuid, deleted: true } })
  })
  it("project delete <name> -> resolves via ProjectList then deletes, exit 0", async () => {
    const r = await runCli(tree(okClient), ["project", "delete", "alpha"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout.join("")).data.deleted).toBe(true)
  })
  it("project delete <unknown name> -> PROJECT_NOT_FOUND on stderr, exit 7", async () => {
    const r = await runCli(tree(okClient), ["project", "delete", "ghost"])
    expect(r.stdout).toEqual([])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "PROJECT_NOT_FOUND", retryable: false })
    expect(r.code).toBe(7)
  })

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

  it("over-length name (>64 chars) -> INVALID_ARGUMENT, exit 2 (server-validated)", async () => {
    const long = "a".repeat(65)
    const r = await runCli(tree(opsClient), ["project", "create", long])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  })
  it("uppercase/illegal name -> INVALID_ARGUMENT, exit 2", async () => {
    const r = await runCli(tree(opsClient), ["project", "create", "BadName"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  })
  it("empty name -> INVALID_ARGUMENT, exit 2", async () => {
    const r = await runCli(tree(opsClient), ["project", "create", ""])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  })
  it("rename missing the new-name arg -> INVALID_ARGUMENT, exit 2", async () => {
    const r = await runCli(tree(opsClient), ["project", "rename", "alpha"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
  })
  it("rename a name that resolves but server reports name conflict -> NAME_CONFLICT, exit 8", async () => {
    const r = await runCli(tree(opsClient), ["project", "rename", "alpha", "taken"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "NAME_CONFLICT", retryable: false })
    expect(r.code).toBe(8)
  })
  it("change-directory to a non-existent path -> DIRECTORY_INVALID, exit 9", async () => {
    const r = await runCli(tree(opsClient), ["project", "change-directory", "alpha", "/nope"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ code: "DIRECTORY_INVALID", retryable: false })
    expect(r.code).toBe(9)
  })
  it("rename a name not in the list -> PROJECT_NOT_FOUND, exit 7 (resolveProjectTarget)", async () => {
    const r = await runCli(tree(missingClient), ["project", "rename", "ghost", "newname"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ code: "PROJECT_NOT_FOUND", retryable: false })
    expect(r.code).toBe(7)
  })
  it("delete by UUID target skips the list lookup and returns ProjectDelete envelope, exit 0", async () => {
    const r = await runCli(tree(opsClient), ["project", "delete", "11111111-1111-4111-8111-111111111111"])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "ProjectDelete", data: { deleted: true } })
    expect(r.code).toBe(0)
  })
  it("list --archived passes includeArchived (still ProjectList envelope), exit 0", async () => {
    const r = await runCli(tree(opsClient), ["project", "list", "--archived"])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "ProjectList" })
    expect(r.code).toBe(0)
  })
})

describe("CLI help (#3)", () => {
  it("health --help explains it is a backend reachability probe", async () => {
    const r = await runCli(tree(okClient), ["health", "--help"])
    const out = r.stdout.join("\n")
    expect(out).toContain("check that a Expand backend is reachable")
  })

  it("expand --help lists health with its description", async () => {
    const r = await runCli(tree(okClient), ["--help"])
    const out = r.stdout.join("\n")
    expect(out).toMatch(/health\s+check that a Expand backend is reachable/)
  })
})
