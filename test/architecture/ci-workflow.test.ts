import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { parse } from "yaml"
import { describe, expect } from "vitest"

const Workflow = Schema.Struct({
  jobs: Schema.Struct({
    "dependency-audit": Schema.Struct({
      name: Schema.String,
      steps: Schema.Array(Schema.Struct({
        name: Schema.optional(Schema.String),
        run: Schema.optional(Schema.String)
      }))
    })
  })
})

describe("CI workflow", () => {
  it.live("audits the complete locked dependency graph", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString(".github/workflows/ci.yml")
      const workflow = yield* Schema.decodeUnknownEffect(Workflow)(parse(source))
      const audit = workflow.jobs["dependency-audit"]
      expect(audit.name).toBe("Dependency audit")
      expect(audit.steps.find((step) => step.name === "Audit locked dependencies")?.run)
        .toBe("npm audit --audit-level=high")
    }).pipe(Effect.provide(NodeServices.layer)))
})
