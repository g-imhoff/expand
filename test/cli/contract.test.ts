import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { makeYodea } from "@yodea/cli/main"
import { runCli, stubLayer } from "./harness"

const okClient = {
  Health: () => Effect.succeed("ok"),
  ProjectCreate: ({ name, ensure }: { name: string; ensure: boolean }) =>
    name === "dup" && !ensure
      ? Effect.fail({ _tag: "ProjectAlreadyExists", name })
      : Effect.succeed({ created: !(name === "dup"), project: { id: "01J", name, createdAt: "2026-01-01T00:00:00.000Z" } }),
  ProjectList: () => Effect.succeed([
    { id: "01K", name: "beta", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "01J", name: "alpha", createdAt: "2026-01-01T00:00:00.000Z" }
  ])
}
const downClient = {
  Health: () => Effect.fail({ _tag: "BackendUnavailable", reason: "no server" }),
  ProjectCreate: () => Effect.fail({ _tag: "BackendUnavailable", reason: "no server" }),
  ProjectList: () => Effect.fail({ _tag: "BackendUnavailable", reason: "no server" })
}
const tree = (stub: object) => makeYodea(stubLayer(stub))

describe("CLI contract", () => {
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
  it("project create 'My Proj' -> INVALID_ARGUMENT on stderr, exit 2 (parse-time)", async () => {
    const r = await runCli(tree(okClient), ["project", "create", "My Proj"])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "INVALID_ARGUMENT" })
    expect(r.code).toBe(2)
    // NOTE: stdout is NOT asserted empty here — the framework prints help to stdout on a parse error.
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
  it("health -> Health envelope", async () => {
    const r = await runCli(tree(okClient), ["health"])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ kind: "Health", data: { status: "ok" } })
    expect(r.code).toBe(0)
  })
})
