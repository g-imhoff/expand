import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { resolveProjectTarget } from "@expand/cli/commands/project/_resolve"

const stub = (projects: ReadonlyArray<{ id: string; name: string }>) =>
  Layer.succeed(ProjectClient, { list: () => Effect.succeed({ projects, seq: 0 }) } as unknown as ProjectClientApi)

const run = (token: string, projects: ReadonlyArray<{ id: string; name: string }>) =>
  resolveProjectTarget(token).pipe(Effect.provide(stub(projects)), Effect.result)

describe("resolveProjectTarget", () => {
  it.effect("returns a UUID token unchanged without listing", () =>
    run("3f2504e0-4f89-41d3-9a0c-0305e82c3301", []).pipe(
      Effect.tap((r) => Effect.sync(() =>
        expect((r as { success: string }).success).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
      ))
    ))
  it.effect("resolves a name to its id", () =>
    run("alpha", [{ id: "id-a", name: "alpha" }]).pipe(
      Effect.tap((r) => Effect.sync(() => expect((r as { success: string }).success).toBe("id-a")))
    ))
  it.effect("fails ProjectNotFound when no project matches the name", () =>
    run("ghost", [{ id: "id-a", name: "alpha" }]).pipe(
      Effect.tap((r) => Effect.sync(() =>
        expect((r as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
      ))
    ))
  it.effect("dies (ambiguous, not ProjectNotFound) when multiple live projects share the name", () =>
    run("dup", [{ id: "a", name: "dup" }, { id: "b", name: "dup" }]).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() =>
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      ))
    ))
})

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false

describe("resolveProjectTarget Effect contract", () => {
  it.effect("returns a UUID without listing projects", () => {
    let listCalls = 0
    const layer = Layer.succeed(ProjectClient, {
      list: () => Effect.sync(() => {
        listCalls += 1
        return { projects: [], seq: 0 }
      })
    } as unknown as ProjectClientApi)
    return resolveProjectTarget("3f2504e0-4f89-41d3-9a0c-0305e82c3301").pipe(
      Effect.provide(layer),
      Effect.tap((id) => Effect.sync(() => {
        expect(id).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        expect(listCalls).toBe(0)
      }))
    )
  })

  it.effect("preserves list transport failures", () => {
    const transport = {
      _tag: "RpcClientError",
      message: "transport"
    } as unknown as import("effect/unstable/rpc").RpcClientError.RpcClientError
    const layer = Layer.succeed(ProjectClient, {
      list: () => Effect.fail(transport)
    } as unknown as ProjectClientApi)
    return resolveProjectTarget("alpha").pipe(
      Effect.provide(layer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toBe(transport)
      }))
    )
  })

  it("exposes the project resolution Effect contract", () => {
    const resolution = resolveProjectTarget("alpha")
    type SuccessMatches = Equal<Effect.Success<typeof resolution>, string>
    type ErrorMatches = Equal<
      Effect.Error<typeof resolution>,
      import("effect/unstable/rpc").RpcClientError.RpcClientError | import("@expand/contracts/rpc").ProjectNotFound
    >
    type ServicesMatch = Equal<Effect.Services<typeof resolution>, ProjectClient>
    const assertions: [SuccessMatches, ErrorMatches, ServicesMatch] = [true, true, true]
    expect(assertions).toEqual([true, true, true])
  })
})
