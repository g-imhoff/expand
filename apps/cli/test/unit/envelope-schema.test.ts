import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ErrorEnvelope, HealthEnvelope, ProjectDeleteEnvelope, ProjectEnvelope, ProjectListEnvelope } from "@yodea/contracts/cli"

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
