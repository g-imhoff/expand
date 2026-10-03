import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import {
  describeRemoteFormError,
  describeRemoteProbe,
  formatRemoteFlag,
  parsePortText,
  validateRemoteForm
} from "@expand/desktop/renderer/features/backend/remote-target"

describe("remote target", () => {
  it("parses port text strictly", () => {
    expect(parsePortText("43111")).toBe(43111)
    expect(parsePortText(" 443 ")).toBe(443)
    expect(parsePortText("")).toBeUndefined()
    expect(parsePortText("abc")).toBeUndefined()
    expect(parsePortText("43.5")).toBeUndefined()
    expect(parsePortText("-1")).toBeUndefined()
    expect(parsePortText("0")).toBeUndefined()
    expect(parsePortText("65536")).toBeUndefined()
    expect(parsePortText("65535")).toBe(65535)
  })

  it("requires a token before anything else", () => {
    expect(validateRemoteForm({ host: "h", portText: "1", url: "", secure: false, token: "  " }))
      .toEqual({ _tag: "TokenRequired" })
  })

  it("accepts host plus port, or a full URL", () => {
    expect(validateRemoteForm({ host: "127.0.0.1", portText: "43111", url: "", secure: false, token: "t" }))
      .toBeUndefined()
    expect(validateRemoteForm({ host: "", portText: "", url: "ws://h:1/rpc", secure: false, token: "t" }))
      .toBeUndefined()
  })

  it("rejects missing targets, bad ports, and non-ws URLs", () => {
    expect(validateRemoteForm({ host: "", portText: "", url: "", secure: false, token: "t" }))
      .toEqual({ _tag: "TargetRequired" })
    expect(validateRemoteForm({ host: "h", portText: "99999", url: "", secure: false, token: "t" }))
      .toEqual({ _tag: "InvalidPort" })
    expect(validateRemoteForm({ host: "", portText: "", url: "http://h/rpc", secure: false, token: "t" }))
      .toEqual({ _tag: "InvalidUrl" })
    expect(validateRemoteForm({ host: "", portText: "", url: "not a url", secure: false, token: "t" }))
      .toEqual({ _tag: "InvalidUrl" })
    expect(validateRemoteForm({ host: "", portText: "", url: "ws://user:pass@h:1/rpc", secure: false, token: "t" }))
      .toEqual({ _tag: "ForbiddenCredentials" })
  })

  it("describes form errors and probes without leaking tokens", () => {
    const secret = "form-secret-xyz"
    expect(describeRemoteFormError({ _tag: "TokenRequired" })).toContain("token")
    const probe = { reachable: true, authenticated: true, detail: "connected to ws://h:1/rpc" }
    expect(describeRemoteProbe(probe)).toContain("Connected")
    expect(describeRemoteProbe({ ...probe, authenticated: false })).toContain("token was rejected")
    expect(describeRemoteProbe({ ...probe, reachable: false, authenticated: false })).toContain("Unreachable")
    expect(formatRemoteFlag(true)).toBe("yes")
    expect(formatRemoteFlag(false)).toBe("no")
    expect(describeRemoteProbe(probe)).not.toContain(secret)
  })
})
