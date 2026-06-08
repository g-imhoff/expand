import { describe, expect, it, vi } from "vitest"
import { render } from "ink-testing-library"
import { MetadataInput } from "@yodea/tui/components/metadata-input"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("MetadataInput", () => {
  it("echoes typed description text", async () => {
    const { stdin, lastFrame } = render(<MetadataInput onSubmit={() => {}} />)
    await flush()
    stdin.write("notes")
    await flush()
    expect(lastFrame()).toContain("notes")
  })
  it("submits the trimmed description on Enter", async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<MetadataInput onSubmit={onSubmit} />)
    await flush()
    stdin.write("hello")
    await flush()
    stdin.write("\r")
    await flush()
    expect(onSubmit).toHaveBeenCalledWith({ description: "hello" })
  })
})
