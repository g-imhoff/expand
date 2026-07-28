import { describe, expect, it } from "vitest"
import {
  payloadSize,
  snapshotSender,
  validateSender,
  type FrameLike,
  type IpcMainEventLike,
  type OriginRule,
  type WindowTargetLike
} from "@expand/electron-ipc/main"

const RULES: ReadonlyArray<OriginRule> = [
  { _tag: "fileProtocol" },
  { _tag: "exactOrigin", origin: "http://localhost:5173" }
]

const frame = (url: string, detached = false): FrameLike => ({ url, detached })

const target = (webContents: unknown, mainFrame: FrameLike | null): WindowTargetLike => ({
  webContents,
  mainFrame,
  postToRenderer: () => {}
})

const event = (sender: unknown, senderFrame: FrameLike | null): IpcMainEventLike => ({ sender, senderFrame })

describe("snapshotSender", () => {
  const wc = { id: 1 }

  it("captures url and main-frame status for the expected sender", () => {
    const main = frame("file:///app/index.html")
    expect(snapshotSender(event(wc, main), target(wc, main))).toEqual({
      url: "file:///app/index.html",
      isMainFrame: true
    })
  })

  it("rejects a foreign WebContents", () => {
    const main = frame("file:///app/index.html")
    expect(snapshotSender(event({ id: 2 }, main), target(wc, main))).toEqual({ url: null, isMainFrame: false })
  })

  it("rejects null and detached frames (Electron 33+ post-await hazard)", () => {
    const main = frame("file:///app/index.html")
    expect(snapshotSender(event(wc, null), target(wc, main))).toEqual({ url: null, isMainFrame: false })
    expect(snapshotSender(event(wc, frame("file:///app/index.html", true)), target(wc, main))).toEqual({
      url: null,
      isMainFrame: false
    })
  })

  it("marks subframes as non-main even with a valid url", () => {
    const main = frame("file:///app/index.html")
    const sub = frame("file:///app/index.html")
    expect(snapshotSender(event(wc, sub), target(wc, main))).toEqual({
      url: "file:///app/index.html",
      isMainFrame: false
    })
  })

  it("keeps the url but marks non-main when the target has no main frame", () => {
    const sender = frame("file:///app/index.html")
    expect(snapshotSender(event(wc, sender), target(wc, null))).toEqual({
      url: "file:///app/index.html",
      isMainFrame: false
    })
  })
})

describe("validateSender", () => {
  it("accepts the packaged file:// main frame", () => {
    expect(validateSender({ url: "file:///opt/app/index.html", isMainFrame: true }, RULES)).toBe(true)
  })

  it("accepts only the exact URL for an exact URL rule", () => {
    const rules: ReadonlyArray<OriginRule> = [
      { _tag: "exactUrl", url: "file:///opt/app/index.html" }
    ]
    expect(validateSender({ url: "file:///opt/app/index.html", isMainFrame: true }, rules)).toBe(true)
    expect(validateSender({ url: "file:///opt/app/hostile.html", isMainFrame: true }, rules)).toBe(false)
    expect(validateSender({ url: "file:///opt/app/index.html?hostile", isMainFrame: true }, rules)).toBe(false)
  })

  it("accepts the exact dev origin", () => {
    expect(validateSender({ url: "http://localhost:5173/", isMainFrame: true }, RULES)).toBe(true)
    expect(validateSender({ url: "http://localhost:5173/some/route?x=1", isMainFrame: true }, RULES)).toBe(true)
  })

  it("rejects lookalike origins — exact match, never startsWith", () => {
    expect(validateSender({ url: "http://localhost:51730/", isMainFrame: true }, RULES)).toBe(false)
    expect(validateSender({ url: "http://localhost.attacker.com:5173/", isMainFrame: true }, RULES)).toBe(false)
    expect(validateSender({ url: "https://localhost:5173/", isMainFrame: true }, RULES)).toBe(false)
  })

  it("rejects subframes, null urls, and unparseable urls", () => {
    expect(validateSender({ url: "file:///opt/app/index.html", isMainFrame: false }, RULES)).toBe(false)
    expect(validateSender({ url: null, isMainFrame: true }, RULES)).toBe(false)
    expect(validateSender({ url: "not a url", isMainFrame: true }, RULES)).toBe(false)
  })

  it("rejects everything when the rule list is empty", () => {
    expect(validateSender({ url: "file:///opt/app/index.html", isMainFrame: true }, [])).toBe(false)
  })

  it("rejects opaque origins — an exactOrigin rule never matches the literal \"null\"", () => {
    // data: pages parse to origin "null"; RULES has fileProtocol + exactOrigin, and a
    // data: URL is neither file: protocol nor a serialized origin, so it must be rejected.
    expect(validateSender({ url: "data:text/html,x", isMainFrame: true }, RULES)).toBe(false)
  })
})

describe("payloadSize", () => {
  it("measures strings, objects, and treats unserializable payloads as oversized", () => {
    expect(payloadSize("abcd")).toBe(4)
    expect(payloadSize(undefined)).toBe(0)
    expect(payloadSize(null)).toBe(0)
    expect(payloadSize({ a: 1 })).toBe(7)
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(payloadSize(circular)).toBe(Number.MAX_SAFE_INTEGER)
    // JSON.stringify returns undefined (no throw) for functions → fail closed (F10).
    expect(payloadSize(() => {})).toBe(Number.MAX_SAFE_INTEGER)
  })
})
