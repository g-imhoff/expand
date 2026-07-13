import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { describe, expect, it } from "vitest"
import { adapter, clientLayer } from "../adapter"

describe("example AppContext composition", () => {
  it("builds the application layer without mutating the runtime adapter", () => {
    const layer = clientLayer(adapter)
    expect(Layer.isLayer(layer)).toBe(true)
    expect(Object.hasOwn(adapter, "nodeAppContextLayer")).toBe(false)
    expect(Layer.isLayer(Layer.provide(layer, NodeServices.layer))).toBe(true)
  })
})
