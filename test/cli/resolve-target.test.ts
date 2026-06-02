import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { YodeaClient, type YodeaClientApi } from "@yodea/client-core"
import { resolveProjectTarget } from "@yodea/cli/commands/project/_resolve"

const stub = (projects: ReadonlyArray<{ id: string; name: string }>) =>
  Layer.succeed(YodeaClient, { ProjectList: () => Effect.succeed(projects) } as unknown as YodeaClientApi)

const run = (token: string, projects: ReadonlyArray<{ id: string; name: string }>) =>
  Effect.runPromise(resolveProjectTarget(token).pipe(Effect.provide(stub(projects)), Effect.result))

describe("resolveProjectTarget", () => {
  it("returns a UUID token unchanged without listing", async () => {
    const r = await run("3f2504e0-4f89-41d3-9a0c-0305e82c3301", [])
    expect((r as { success: string }).success).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
  })
  it("resolves a name to its id", async () => {
    const r = await run("alpha", [{ id: "id-a", name: "alpha" }])
    expect((r as { success: string }).success).toBe("id-a")
  })
  it("fails ProjectNotFound when no project matches the name", async () => {
    const r = await run("ghost", [{ id: "id-a", name: "alpha" }])
    expect((r as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })
  it("dies (ambiguous, not ProjectNotFound) when multiple live projects share the name", async () => {
    // Names are unique among live projects, so >1 match is an invariant violation,
    // not a user-facing "not found". It must surface as an Unexpected defect, which
    // Effect.result does NOT catch — so the promise rejects rather than resolving.
    await expect(run("dup", [{ id: "a", name: "dup" }, { id: "b", name: "dup" }])).rejects.toThrow()
  })
})
