import { describe, expect, it } from "vitest"
import React from "react"
import { Text } from "ink"
import { render } from "ink-testing-library"
import { useKeyRouter } from "@yodea/ink-input/use-key-router-ink"
import type { KeyName } from "@yodea/ink-input/key-name"

const Probe = ({ log }: { log: Array<{ keyName: KeyName; input: string }> }) => {
  useKeyRouter((keyName, input) => { log.push({ keyName, input }) })
  return <Text>probe</Text>
}

const tick = () => new Promise((r) => setTimeout(r, 20))

describe("useKeyRouter", () => {
  it("delivers normalized key names for printable and special keys", async () => {
    const log: Array<{ keyName: KeyName; input: string }> = []
    const { stdin } = render(<Probe log={log} />)
    await tick()
    stdin.write("a")
    await tick()
    stdin.write("\x1b") // escape
    await tick()
    stdin.write("\r") // return
    await tick()
    expect(log.map((e) => e.keyName)).toEqual(["a", "escape", "return"])
    expect(log[0]?.input).toBe("a")
  })

  it("delivers paste as a single multi-char input", async () => {
    const log: Array<{ keyName: KeyName; input: string }> = []
    const { stdin } = render(<Probe log={log} />)
    await tick()
    stdin.write("data")
    await tick()
    expect(log).toEqual([{ keyName: "data", input: "data" }])
  })
})
