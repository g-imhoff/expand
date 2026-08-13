import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import {
  ProcessControl,
  ProcessProbeError,
  type ProcessControlShape,
  type ProcessStatus
} from "@expand/contracts/process-control"

describe("ProcessControl", () => {
  it("requires ProcessControl in the Effect environment", () => {
    const processControlProgram = ProcessControl

    expectTypeOf(processControlProgram).toMatchTypeOf<
      Effect.Effect<ProcessControlShape, never, ProcessControl>
    >()
  })

  it("defines the three platform-neutral process states", () => {
    expectTypeOf<ProcessStatus>().toEqualTypeOf<"alive" | "dead" | "inaccessible">()
  })

  it.effect("preserves the probed pid and cause in unknown failures", () => {
    const cause = new TypeError("unexpected probe failure")
    const error = new ProcessProbeError({ pid: 42, cause })

    return Effect.sync(() => {
      expect(error).toMatchObject({ _tag: "ProcessProbeError", pid: 42, cause })
    })
  })

  it.effect.fails("surfaces failed Effects through the Effect Vitest boundary", () =>
    Effect.fail("expected Effect failure"))

  it.effect("has no ambient ProcessControl service", () =>
    Effect.serviceOption(ProcessControl).pipe(
      Effect.map((service) => expect(Option.isNone(service)).toBe(true))
    ))
})
