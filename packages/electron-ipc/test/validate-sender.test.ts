import { describe, expect, it } from "vitest"
import {
  payloadSize,
  snapshotSender,
  validateSender,
  type FrameLike,
  type IpcMainEventLike,
  type OriginRule,
  type WindowTargetLike
} from "@yodea/electron-ipc/main"

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
})

describe("validateSender", () => {
  it("accepts the packaged file:// main frame", () => {
    expect(validateSender({ url: "file:///opt/app/index.html", isMainFrame: true }, RULES)).toBe(true)
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
})

describe("payloadSize", () => {
  it("measures strings, objects, and treats unserializable payloads as oversized", () => {
    expect(payloadSize("abcd")).toBe(4)
    expect(payloadSize(undefined)).toBe(0)
    expect(payloadSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length)
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(payloadSize(circular)).toBe(Number.MAX_SAFE_INTEGER)
  })
})
