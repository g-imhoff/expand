import { describe, expect, it } from "vitest"
import { originRulesFor, prodOriginRules } from "@expand/desktop/main/ipc/origin-rules"

describe("origin rules", () => {
  it("prod rules are file-protocol only — the dev carve-out cannot ship (spec §10.2 pin)", () => {
    expect(prodOriginRules).toEqual([{ _tag: "fileProtocol" }])
  })

  it("dev adds the exact vite origin", () => {
    expect(originRulesFor("http://localhost:5173/")).toEqual([
      { _tag: "fileProtocol" },
      { _tag: "exactOrigin", origin: "http://localhost:5173" }
    ])
  })

  it("no devUrl → prod rules", () => {
    expect(originRulesFor(undefined)).toEqual(prodOriginRules)
  })
})
