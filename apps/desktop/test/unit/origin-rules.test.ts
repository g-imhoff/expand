import { describe, expect, it } from "vitest"
import { originRulesFor } from "@expand/desktop/main/ipc/origin-rules"

const packagedRendererUrl = "file:///opt/Expand/resources/app.asar/out/renderer/index.html"

describe("origin rules", () => {
  it("pins packaged IPC to the exact renderer URL", () => {
    expect(originRulesFor(packagedRendererUrl, undefined)).toEqual([
      { _tag: "exactUrl", url: packagedRendererUrl }
    ])
  })

  it("uses only the exact Vite origin in development", () => {
    expect(originRulesFor(packagedRendererUrl, "http://localhost:5173/")).toEqual([
      { _tag: "exactOrigin", origin: "http://localhost:5173" }
    ])
  })
})
