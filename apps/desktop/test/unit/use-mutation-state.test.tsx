// @vitest-environment happy-dom
import { type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect, vi } from "vitest"
import { makeRendererRunner, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { useRunMutation } from "@expand/desktop/renderer/features/projects/data/use-projects"

const waitForDeferred = Deferred["\u0061wait"]

interface StartedMutation {
  readonly cancel: () => void
  readonly fail: (error: unknown) => void
  readonly succeed: (value: unknown) => void
}

const makeRunnerHarness = () => {
  const started: Array<StartedMutation> = []
  const runner: RendererRunner = {
    start: <A, E,>(
      _effect: Effect.Effect<A, E>,
      onExit: (exit: Exit.Exit<A, E>) => void
    ) => {
      const cancel = vi.fn()
      started.push({
        cancel,
        fail: (error) => onExit(Exit.fail(error as E)),
        succeed: (value) => onExit(Exit.succeed(value as A))
      })
      return cancel
    }
  }
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <RendererRunnerProvider value={runner}>{children}</RendererRunnerProvider>
  )
  return { runner, started, wrapper }
}

describe("useRunMutation", () => {
  it("publishes success through callbacks and clears pending state", () => {
    const harness = makeRunnerHarness()
    const { result } = renderHook(
      () => useRunMutation((n: number) => Effect.succeed(n * 2)),
      { wrapper: harness.wrapper }
    )
    const onSuccess = vi.fn()

    act(() => result.current.mutate(3, { onSuccess }))

    expect(result.current.isPending).toBe(true)
    expect(Object.keys(result.current)).toEqual(["mutate", "error", "isPending", "reset"])
    act(() => harness.started[0]?.succeed(6))
    expect(onSuccess).toHaveBeenCalledWith(6)
    expect(result.current.isPending).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it("publishes typed errors through callbacks and reset clears mutation state", () => {
    const boom = new Error("boom")
    const harness = makeRunnerHarness()
    const { result } = renderHook(
      () => useRunMutation((_: void) => Effect.fail(boom)),
      { wrapper: harness.wrapper }
    )
    const onError = vi.fn()

    act(() => result.current.mutate(undefined, { onError }))
    act(() => harness.started[0]?.fail(boom))

    expect(onError).toHaveBeenCalledWith(boom)
    expect(result.current.error).toBe(boom)
    expect(result.current.isPending).toBe(false)
    act(() => result.current.reset())
    expect(result.current.error).toBeUndefined()
    expect(result.current.isPending).toBe(false)
  })

  it.effect("propagates mutation defects through the runner owner failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const defect = new Error("mutation defect")
        const owner = yield* makeRendererRunner()
        const callbackCompleted = yield* Deferred.make<void>()
        const ownerFailure = yield* Effect.forkChild(Effect.exit(owner.failure))
        let callbackDefect: unknown
        const runner: RendererRunner = {
          start: (effect, onExit) =>
            owner.runner.start(effect, (exit) => {
              try {
                onExit(exit)
              } catch (error) {
                callbackDefect = error
                throw error
              } finally {
                Deferred.doneUnsafe(callbackCompleted, Effect.void)
              }
            })
        }
        const wrapper = ({ children }: { readonly children: ReactNode }) => (
          <RendererRunnerProvider value={runner}>{children}</RendererRunnerProvider>
        )
        const { result, unmount } = renderHook(
          () => useRunMutation((_: void) => Effect.die(defect)),
          { wrapper }
        )

        act(() => result.current.mutate(undefined))
        yield* waitForDeferred(callbackCompleted)

        expect(callbackDefect).toBe(defect)
        const ownerExit = yield* Fiber.join(ownerFailure)
        expect(Exit.isFailure(ownerExit)).toBe(true)
        if (Exit.isFailure(ownerExit)) expect(Cause.squash(ownerExit.cause)).toBe(defect)
        unmount()
      })
    ))

  it("uses the latest mutation function without changing mutate identity", () => {
    const harness = makeRunnerHarness()
    const first = vi.fn((n: number) => Effect.succeed(n))
    const second = vi.fn((n: number) => Effect.succeed(n * 2))
    const { result, rerender } = renderHook(
      ({ run }) => useRunMutation(run),
      { initialProps: { run: first }, wrapper: harness.wrapper }
    )
    const mutate = result.current.mutate

    rerender({ run: second })
    act(() => result.current.mutate(4))

    expect(result.current.mutate).toBe(mutate)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(4)
  })

  it("interrupts the active mutation and ignores a late exit after unmount", () => {
    const harness = makeRunnerHarness()
    const { result, unmount } = renderHook(
      () => useRunMutation((_: void) => Effect.succeed("done")),
      { wrapper: harness.wrapper }
    )
    const onSuccess = vi.fn()

    act(() => result.current.mutate(undefined, { onSuccess }))
    unmount()
    expect(harness.started[0]?.cancel).toHaveBeenCalledOnce()
    act(() => harness.started[0]?.succeed("done"))
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("keeps separate hook instances independently owned", () => {
    const harness = makeRunnerHarness()
    const { result } = renderHook(
      () => ({
        first: useRunMutation((n: number) => Effect.succeed(n)),
        second: useRunMutation((n: number) => Effect.succeed(n))
      }),
      { wrapper: harness.wrapper }
    )

    act(() => {
      result.current.first.mutate(1)
      result.current.second.mutate(2)
    })

    expect(harness.started[0]?.cancel).not.toHaveBeenCalled()
    expect(result.current.first.isPending).toBe(true)
    expect(result.current.second.isPending).toBe(true)
    act(() => harness.started[0]?.succeed(1))
    expect(result.current.first.isPending).toBe(false)
    expect(result.current.second.isPending).toBe(true)
  })

  it("lets only the latest invocation publish after supersession", () => {
    const harness = makeRunnerHarness()
    const { result } = renderHook(
      () => useRunMutation((n: number) => Effect.succeed(n)),
      { wrapper: harness.wrapper }
    )
    const staleError = new Error("stale")
    const firstOnError = vi.fn()
    const secondOnSuccess = vi.fn()

    act(() => result.current.mutate(1, { onError: firstOnError }))
    act(() => result.current.mutate(2, { onSuccess: secondOnSuccess }))

    expect(harness.started[0]?.cancel).toHaveBeenCalledOnce()
    expect(result.current.isPending).toBe(true)
    act(() => harness.started[1]?.succeed(2))
    expect(secondOnSuccess).toHaveBeenCalledWith(2)
    expect(result.current.error).toBeUndefined()
    expect(result.current.isPending).toBe(false)

    act(() => harness.started[0]?.fail(staleError))
    expect(firstOnError).not.toHaveBeenCalled()
    expect(result.current.error).toBeUndefined()
    expect(result.current.isPending).toBe(false)
  })
})
