import { describe, expect, it } from "vitest"
import { hardenWebContents, type HardenDeps } from "@yodea/desktop/main/security/harden-web-contents"

const makeDeps = () => {
  const navHandlers: Array<(e: { preventedDefault: boolean; url: string }) => void> = []
  let windowOpenHandler: ((d: { url: string }) => { action: string }) | undefined
  const deps: HardenDeps = {
    onWillNavigate: (cb) =>
      navHandlers.push((e) => cb({ preventDefault: () => { e.preventedDefault = true } }, e.url)),
    setWindowOpenHandler: (h) => { windowOpenHandler = h },
    isAllowed: (url) => url.startsWith("app://") || url.startsWith("http://localhost")
  }
  return {
    deps,
    navigateTo: (url: string) => {
      const e = { preventedDefault: false, url }
      navHandlers.forEach((h) => h(e))
      return e.preventedDefault
    },
    openWindow: (url: string) => windowOpenHandler?.({ url })
  }
}

describe("hardenWebContents", () => {
  it("prevents navigation to disallowed origins and allows the renderer origin", () => {
    const h = makeDeps()
    hardenWebContents(h.deps)
    expect(h.navigateTo("https://evil.example")).toBe(true)               // prevented
    expect(h.navigateTo("http://localhost:5173/index.html")).toBe(false)  // allowed
  })
  it("denies all window-open requests", () => {
    const h = makeDeps()
    hardenWebContents(h.deps)
    expect(h.openWindow("https://evil.example")).toEqual({ action: "deny" })
  })
})
