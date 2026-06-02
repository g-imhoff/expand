import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ErrorEnvelope, HealthEnvelope, ProjectDeleteEnvelope, ProjectEnvelope, ProjectListEnvelope } from "@yodea/contracts/cli"

// Freeze the yodea/v1 envelope shapes. A change here is a CONTRACT change: it must
// be intentional, bump API_VERSION, and update this snapshot in the same commit.
// An accidental shape drift fails CI here.
//
// Mechanism: `Schema.toJsonSchemaDocument` (effect v4 beta) derives a deterministic,
// fully structural JSON Schema (draft-2020-12) from each envelope — capturing every
// field name, its type, required-ness, and `additionalProperties`. Any added /
// removed / renamed field changes this output and fails the snapshot below.
const shapeOf = (schema: Schema.Top): unknown => Schema.toJsonSchemaDocument(schema)

describe("envelope contract (yodea/v1)", () => {
  it("matches the frozen envelope-shape snapshot", () => {
    expect({
      ProjectEnvelope: shapeOf(ProjectEnvelope),
      ProjectListEnvelope: shapeOf(ProjectListEnvelope),
      ProjectDeleteEnvelope: shapeOf(ProjectDeleteEnvelope),
      HealthEnvelope: shapeOf(HealthEnvelope),
      ErrorEnvelope: shapeOf(ErrorEnvelope)
    }).toMatchSnapshot()
  })
})
