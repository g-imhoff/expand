import { describe, expect, it } from "vitest"
import { Schema, SchemaRepresentation } from "effect"
import { ErrorEnvelope } from "@expand/cli/errors/envelope"
import { ProjectDeleteEnvelope, ProjectEnvelope, ProjectListEnvelope } from "@expand/cli/contract/project/envelope"
import { HealthEnvelope } from "@expand/cli/contract/server/envelope"

const shapeOf = (schema: Schema.Top): unknown =>
  SchemaRepresentation.toJsonSchemaDocument(
    Schema.toRepresentation(Schema.toEncoded(schema)),
    { onExcessProperty: "error" }
  )

describe("envelope contract (expand/v1)", () => {
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
