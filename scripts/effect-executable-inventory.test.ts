import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  ExecutableInventory,
  ExecutableInventoryError,
  type ExecutableObservation,
  validateExecutableInventoryRecords
} from "./effect-executable-inventory"

const runnerBoundary = {
  declaration: { kind: "module", name: "<module>" },
  construct: "runner:NodeRuntime.runMain",
  occurrence: 0
} as const

const observations: ReadonlyArray<ExecutableObservation> = [
  {
    file: "scripts/example.ts",
    declaration: { kind: "module", name: "<module>" },
    kind: "effect-entrypoint",
    invocation: { file: "package.json", selector: "scripts.example", occurrence: 0 },
    hostBoundary: runnerBoundary
  },
  {
    file: "scripts/example.ts",
    declaration: { kind: "module", name: "<module>" },
    kind: "effect-entrypoint",
    invocation: { file: "scripts/example.ts", selector: "runner:NodeRuntime.runMain", occurrence: 0 },
    hostBoundary: runnerBoundary
  }
]

const inventory = {
  version: 1 as const,
  entrypoints: [{
    file: "scripts/example.ts",
    declaration: { kind: "module", name: "<module>" },
    kind: "effect-entrypoint" as const,
    invokedBy: observations.map(({ invocation }) => invocation),
    hostBoundary: runnerBoundary
  }]
}

const failureDetail = <A>(effect: Effect.Effect<A, ExecutableInventoryError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.detail))

describe("ExecutableInventory schema", () => {
  it.effect("decodes the versioned exact model", () =>
    Schema.decodeUnknownEffect(ExecutableInventory)(inventory).pipe(
      Effect.map((decoded) => expect(decoded).toEqual(inventory))
    ))

  it.effect("rejects malformed paths, globs, directories, duplicates, and untracked entries", () =>
    Effect.gen(function*() {
      for (const file of ["/absolute.ts", "scripts/*.ts", "scripts/"]) {
        const changed = { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, file }] }
        expect(yield* failureDetail(validateExecutableInventoryRecords(changed, observations, {
          trackedFiles: ["package.json", "scripts/example.ts"],
          trackedModes: new Map([["scripts/example.ts", "100644"]]),
          sourceHashes: new Map()
        }))).toContain("path")
      }
      const duplicate = { ...inventory, entrypoints: [...inventory.entrypoints, inventory.entrypoints[0]!] }
      expect(yield* failureDetail(validateExecutableInventoryRecords(duplicate, observations, {
        trackedFiles: ["package.json", "scripts/example.ts"],
        trackedModes: new Map([["scripts/example.ts", "100644"]]),
        sourceHashes: new Map()
      }))).toContain("duplicate")
      expect(yield* failureDetail(validateExecutableInventoryRecords(inventory, observations, {
        trackedFiles: [],
        trackedModes: new Map(),
        sourceHashes: new Map()
      }))).toContain("tracked")
    }))

  it.effect("rejects missing, stale, duplicate, and occurrence-shifted invocation links", () =>
    Effect.gen(function*() {
      const variants = [
        { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, invokedBy: observations.slice(0, 1).map(({ invocation }) => invocation) }] },
        { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, invokedBy: [...inventory.entrypoints[0]!.invokedBy, { file: "other.json", selector: "scripts.other", occurrence: 0 }] }] },
        { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, invokedBy: [...inventory.entrypoints[0]!.invokedBy, inventory.entrypoints[0]!.invokedBy[0]!] }] },
        { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, invokedBy: inventory.entrypoints[0]!.invokedBy.map((link, index) => index === 0 ? { ...link, occurrence: 1 } : link) }] }
      ]
      for (const changed of variants) {
        expect(yield* failureDetail(validateExecutableInventoryRecords(changed, observations, {
          trackedFiles: ["package.json", "scripts/example.ts"],
          trackedModes: new Map([["scripts/example.ts", "100644"]]),
          sourceHashes: new Map()
        }))).toMatch(/invocation|duplicate/)
      }
    }))

  it.effect("requires the sole host fixture to have one exact invocation and primitive boundary", () => {
    const hash = "a".repeat(64)
    const fixtureObservations: ReadonlyArray<ExecutableObservation> = [
      {
        file: "scripts/fixtures/job-control.sh",
        declaration: { kind: "script", name: "<script>" },
        kind: "registered-host-fixture",
        invocation: { file: "scripts/binary-smoke.ts", selector: "host-primitive:job-control", occurrence: 0 },
        sourceHash: hash
      },
      {
        file: "scripts/fixtures/job-control.sh",
        declaration: { kind: "script", name: "<script>" },
        kind: "registered-host-fixture",
        invocation: { file: "scripts/binary-smoke.test.ts", selector: "child-process:scripts/fixtures/job-control.sh", occurrence: 0 },
        sourceHash: hash
      }
    ]
    return failureDetail(validateExecutableInventoryRecords({
      version: 1,
      entrypoints: [{
        file: "scripts/fixtures/job-control.sh",
        declaration: { kind: "script", name: "<script>" },
        kind: "registered-host-fixture",
        invokedBy: fixtureObservations.map(({ invocation }) => invocation),
        sourceHash: hash
      }]
    }, fixtureObservations, {
      trackedFiles: ["scripts/binary-smoke.test.ts", "scripts/binary-smoke.ts", "scripts/fixtures/job-control.sh"],
      trackedModes: new Map([["scripts/fixtures/job-control.sh", "100755"]]),
      sourceHashes: new Map([["scripts/fixtures/job-control.sh", hash]])
    })).pipe(Effect.map((detail) => expect(detail).toContain("one exact invocation")))
  })

  it.effect("rejects declaration, kind, runner-link, mode, and hash drift", () =>
    Effect.gen(function*() {
      const context = {
        trackedFiles: ["package.json", "scripts/example.ts"],
        trackedModes: new Map([["scripts/example.ts", "100644"]]),
        sourceHashes: new Map<string, string>()
      }
      const variants = [
        { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, declaration: { kind: "function", name: "main" } }] },
        { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, kind: "effect-free-transport-shim" as const }] },
        { ...inventory, entrypoints: [{ ...inventory.entrypoints[0]!, hostBoundary: { ...runnerBoundary, occurrence: 1 } }] }
      ]
      for (const changed of variants) {
        expect(yield* failureDetail(validateExecutableInventoryRecords(changed, observations, context))).toMatch(/declaration|kind|host boundary/)
      }

      const hostObservation: ReadonlyArray<ExecutableObservation> = [{
        file: ".githooks/pre-commit",
        declaration: { kind: "script", name: "<script>" },
        kind: "registered-host-launcher",
        invocation: { file: ".githooks/pre-commit", selector: "git-mode", occurrence: 0 },
        sourceHash: "a".repeat(64)
      }]
      const hostInventory = {
        version: 1 as const,
        entrypoints: [{
          file: ".githooks/pre-commit",
          declaration: { kind: "script", name: "<script>" },
          kind: "registered-host-launcher" as const,
          invokedBy: [hostObservation[0]!.invocation],
          sourceHash: "a".repeat(64)
        }]
      }
      expect(yield* failureDetail(validateExecutableInventoryRecords(hostInventory, hostObservation, {
        trackedFiles: [".githooks/pre-commit"],
        trackedModes: new Map([[".githooks/pre-commit", "100644"]]),
        sourceHashes: new Map([[".githooks/pre-commit", "a".repeat(64)]])
      }))).toContain("100755")
      expect(yield* failureDetail(validateExecutableInventoryRecords(hostInventory, hostObservation, {
        trackedFiles: [".githooks/pre-commit"],
        trackedModes: new Map([[".githooks/pre-commit", "100755"]]),
        sourceHashes: new Map([[".githooks/pre-commit", "b".repeat(64)]])
      }))).toContain("hash")
    }))
})
