import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  IpcChannel,
  IpcContract,
  isPortGrantMessage,
  isResultEnvelope,
  portGrantName,
  portRequestName,
  wireName
} from "@expand/electron-ipc/contract"

describe("IpcChannel constructors", () => {
  it("tags each kind discriminately", () => {
    expect(IpcChannel.send({ payload: Schema.String })._kind).toBe("send")
    expect(
      IpcChannel.invoke({ payload: Schema.String, success: Schema.Number, error: Schema.String })._kind
    ).toBe("invoke")
    expect(IpcChannel.event({ payload: Schema.String })._kind).toBe("event")
    expect(IpcChannel.portExchange()._kind).toBe("portExchange")
  })
})

describe("IpcContract.make", () => {
  it("derives wire names from prefix and key", () => {
    const contract = IpcContract.make("expand", { rpcPort: IpcChannel.portExchange() })
    expect(wireName(contract, "rpcPort")).toBe("expand:rpcPort")
    expect(portRequestName(contract, "rpcPort")).toBe("expand:rpcPort:request")
    expect(portGrantName(contract, "rpcPort")).toBe("expand:rpcPort:grant")
  })

  it("rejects prefixes and keys that could split or collide wire names", () => {
    expect(() => IpcContract.make("yo:dea", { a: IpcChannel.portExchange() })).toThrow()
    expect(() => IpcContract.make("expand", { "a:b": IpcChannel.portExchange() })).toThrow()
    expect(() => IpcContract.make("", { a: IpcChannel.portExchange() })).toThrow()
    expect(() => IpcContract.make("expand", { "": IpcChannel.portExchange() })).toThrow()
    expect(() => IpcContract.make("expand", { Ab: IpcChannel.portExchange() })).toThrow()
    expect(() => IpcContract.make("expand", { "1a": IpcChannel.portExchange() })).toThrow()
    expect(() => IpcContract.make("expand", { a_b: IpcChannel.portExchange() })).toThrow()
    expect(() => IpcContract.make("expand", { "a.b": IpcChannel.portExchange() })).toThrow()
  })

  it("accepts camelCase keys", () => {
    expect(() => IpcContract.make("expand", { a1B: IpcChannel.portExchange() })).not.toThrow()
  })
})

describe("envelope guards", () => {
  it("isResultEnvelope accepts only the three envelope tags", () => {
    expect(isResultEnvelope({ _tag: "IpcSuccess", value: 1 })).toBe(true)
    expect(isResultEnvelope({ _tag: "IpcFailure", error: {} })).toBe(true)
    expect(isResultEnvelope({ _tag: "IpcDefect", message: "x" })).toBe(true)
    expect(isResultEnvelope({ _tag: "IpcDefect" })).toBe(false)
    expect(isResultEnvelope({ _tag: "Other" })).toBe(false)
    expect(isResultEnvelope(null)).toBe(false)
    expect(isResultEnvelope("IpcSuccess")).toBe(false)
  })

  it("isPortGrantMessage validates shape strictly", () => {
    expect(isPortGrantMessage({ _tag: "IpcPortGrant", channel: "expand:rpcPort", nonce: "n1" })).toBe(true)
    expect(isPortGrantMessage({ _tag: "IpcPortGrant", channel: "expand:rpcPort" })).toBe(false)
    expect(isPortGrantMessage({ _tag: "IpcPortGrant", channel: 3, nonce: "n1" })).toBe(false)
    expect(isPortGrantMessage("expand:port")).toBe(false)
    expect(isPortGrantMessage(null)).toBe(false)
  })
})
