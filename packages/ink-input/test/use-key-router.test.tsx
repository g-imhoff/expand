import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import React from "react"
import { Text } from "ink"
import { render } from "ink-testing-library"
import { useKeyRouter } from "@expand/ink-input/use-key-router-ink"
import type { KeyName } from "@expand/ink-input/key-name"

const Probe = ({ log }: { log: Array<{ keyName: KeyName; input: string }> }) => {
  useKeyRouter((keyName, input) => { log.push({ keyName, input }) })
  return <Text>probe</Text>
}

const renderScoped = <A extends React.ReactElement>(element: A) =>
  Effect.acquireRelease(
    Effect.sync(() => render(element)),
    (instance) => Effect.sync(() => instance.unmount())
  )

describe("useKeyRouter", () => {
  it.live("delivers normalized key names for printable and special keys", () =>
    Effect.scoped(Effect.gen(function*() {
      const log: Array<{ keyName: KeyName; input: string }> = []
      const { stdin } = yield* renderScoped(<Probe log={log} />)
      yield* Effect.sleep("20 millis")
      stdin.write("a")
      yield* Effect.sleep("20 millis")
      stdin.write("\x1b")
      yield* Effect.sleep("20 millis")
      stdin.write("\r")
      yield* Effect.sleep("20 millis")
      expect(log.map((event) => event.keyName)).toEqual(["a", "escape", "return"])
      expect(log[0]?.input).toBe("a")
    })))

  it.live("delivers paste as a single multi-char input", () =>
    Effect.scoped(Effect.gen(function*() {
      const log: Array<{ keyName: KeyName; input: string }> = []
      const { stdin } = yield* renderScoped(<Probe log={log} />)
      yield* Effect.sleep("20 millis")
      stdin.write("data")
      yield* Effect.sleep("20 millis")
      expect(log).toEqual([{ keyName: "data", input: "data" }])
    })))
})
