import { describe, expect, it } from "vitest"
import { wirePortLifecycle } from "@yodea/desktop/main/ipc/port-lifecycle"

describe("wirePortLifecycle (spec §8: reload hardening)", () => {
  const harness = () => {
    let navigate: ((details: { isSameDocument: boolean }) => void) | undefined
    let closed: (() => void) | undefined
    const calls: Array<string> = []
    wirePortLifecycle({
      onNavigation: (cb) => {
        navigate = cb
      },
      onClosed: (cb) => {
        closed = cb
      },
      teardownPort: () => calls.push("teardownPort"),
      unbind: () => calls.push("unbind")
    })
    return { navigate: navigate!, closed: closed!, calls }
  }

  it("tears down the port on non-same-document navigation (renderer reload)", () => {
    const { navigate, calls } = harness()
    navigate({ isSameDocument: false })
    expect(calls).toEqual(["teardownPort"])
  })

  it("ignores same-document navigation", () => {
    const { navigate, calls } = harness()
    navigate({ isSameDocument: true })
    expect(calls).toEqual([])
  })

  it("unbinds IPC and tears down the port when the window closes", () => {
    const { closed, calls } = harness()
    closed()
    expect(calls).toEqual(["unbind", "teardownPort"])
  })
})
