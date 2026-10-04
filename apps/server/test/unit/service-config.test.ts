import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { serviceHealthBody } from "@expand/server/transport/http-server"
import {
  advertisedHostFor,
  DEFAULT_SERVICE_HOST,
  DEFAULT_SERVICE_PORT,
  hostFromArgs,
  portFromArgs,
  resolveServiceHost,
  resolveServicePort,
  SERVICE_CONTAINER_PORT,
  SERVICE_HEALTH_PATH
} from "@expand/server/runtime/service-config"

const HealthPayload = Schema.Struct({ status: Schema.Literal("ok") })
const decodeHealth = Schema.decodeUnknownSync(Schema.fromJsonString(HealthPayload))

describe("service config", () => {
  it("keeps secure local defaults", () => {
    expect(DEFAULT_SERVICE_HOST).toBe("127.0.0.1")
    expect(DEFAULT_SERVICE_PORT).toBe(0)
    expect(resolveServiceHost(undefined, undefined)).toBe("127.0.0.1")
    expect(resolveServicePort(undefined, undefined)).toBe(0)
  })

  it("reads host and port flags", () => {
    expect(hostFromArgs(["--host", "0.0.0.0"])).toBe("0.0.0.0")
    expect(hostFromArgs([])).toBeUndefined()
    expect(portFromArgs(["--port", "3210"])).toBe(3210)
    expect(portFromArgs([])).toBeUndefined()
  })

  it("prefers flags over environment", () => {
    expect(resolveServiceHost("0.0.0.0", "127.0.0.1")).toBe("0.0.0.0")
    expect(resolveServiceHost(undefined, "0.0.0.0")).toBe("0.0.0.0")
    expect(resolveServicePort(3210, "4321")).toBe(3210)
    expect(resolveServicePort(undefined, "3210")).toBe(3210)
  })

  it("rejects hosts outside the single-owner allowlist", () => {
    expect(() => resolveServiceHost("192.168.1.10", undefined)).toThrow()
    expect(() => resolveServiceHost("localhost", undefined)).toThrow()
    expect(() => resolveServiceHost("", undefined)).toThrow()
  })

  it("rejects ports outside 0..65535", () => {
    expect(() => resolveServicePort(-1, undefined)).toThrow()
    expect(() => resolveServicePort(65536, undefined)).toThrow()
    expect(() => resolveServicePort(Number.NaN, undefined)).toThrow()
    expect(() => resolveServicePort(undefined, "not-a-port")).toThrow()
    expect(() => resolveServicePort(undefined, "")).toThrow()
  })

  it("advertises loopback for local clients when bound to all interfaces", () => {
    expect(advertisedHostFor("0.0.0.0")).toBe("127.0.0.1")
    expect(advertisedHostFor("127.0.0.1")).toBe("127.0.0.1")
  })

  it("pins the container port and health path", () => {
    expect(SERVICE_CONTAINER_PORT).toBe(3210)
    expect(SERVICE_HEALTH_PATH).toBe("/healthz")
  })

  it("encodes the unauthenticated health payload with a Schema codec", () => {
    expect(decodeHealth(serviceHealthBody)).toEqual({ status: "ok" })
  })
})
