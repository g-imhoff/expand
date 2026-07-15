import { it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { describe, expect } from "vitest"
import { hardenWebContents, type HardenDeps } from "@expand/desktop/main/security/harden-web-contents"

const makeDeps = () => {
  type Navigation = (event: { preventDefault: () => void }, url: string) => void
  let navigation: Navigation | undefined
  let windowOpen: ((details: { url: string }) => { action: "deny" }) | undefined
  let disposals = 0
  const deps: HardenDeps = {
    onWillNavigate: (listener) => {
      navigation = listener
      return () => {
        disposals += 1
        if (navigation === listener) navigation = undefined
      }
    },
    setWindowOpenHandler: (handler) => { windowOpen = handler },
    isAllowed: (url) => url.startsWith("app://") || url.startsWith("http://localhost")
  }
  return {
    deps,
    navigateTo: (url: string) => {
      let prevented = false
      navigation?.({ preventDefault: () => { prevented = true } }, url)
      return prevented
    },
    openWindow: (url: string) => windowOpen?.({ url }),
    disposals: () => disposals
  }
}

describe("hardenWebContents", () => {
  it.effect("allows only configured navigation and denies every window-open request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeDeps()
        yield* hardenWebContents(harness.deps)
        expect(harness.navigateTo("https://evil.example")).toBe(true)
        expect(harness.navigateTo("http://localhost:5173/index.html")).toBe(false)
        expect(harness.openWindow("https://evil.example")).toEqual({ action: "deny" })
      })
    ))

  it.effect("removes its exact navigation callback once with the owner scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeDeps()
        const scope = yield* Scope.make()
        yield* hardenWebContents(harness.deps).pipe(Scope.provide(scope))
        yield* Scope.close(scope, Exit.void)
        expect(harness.disposals()).toBe(1)
        expect(harness.navigateTo("https://evil.example")).toBe(false)
        yield* Scope.close(scope, Exit.void)
        expect(harness.disposals()).toBe(1)
      })
    ))
})
