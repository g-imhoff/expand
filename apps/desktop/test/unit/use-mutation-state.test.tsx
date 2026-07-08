// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useRunMutation } from "@expand/desktop/renderer/features/projects/data/use-projects"

describe("useRunMutation", () => {
  it("resolves, fires onSuccess, and clears isPending", async () => {
    const { result } = renderHook(() => useRunMutation((n: number) => Promise.resolve(n * 2)))
    let seen: number | undefined
    act(() => { result.current.mutate(3, { onSuccess: (v) => { seen = v } }) })
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(seen).toBe(6)
    expect(result.current.error).toBeUndefined()
  })

  it("captures error and fires onError", async () => {
    const boom = new Error("boom")
    const { result } = renderHook(() => useRunMutation((_: void) => Promise.reject(boom)))
    let seen: unknown
    act(() => { result.current.mutate(undefined, { onError: (e) => { seen = e } }) })
    await waitFor(() => expect(result.current.error).toBe(boom))
    expect(seen).toBe(boom)
  })

  it("mutateAsync rejects on failure", async () => {
    const boom = new Error("nope")
    const { result } = renderHook(() => useRunMutation((_: void) => Promise.reject(boom)))
    await expect(result.current.mutateAsync(undefined)).rejects.toBe(boom)
  })
})
