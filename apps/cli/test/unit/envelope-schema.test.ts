import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ErrorEnvelope } from "@expand/cli/errors/envelope"
import { ProjectDeleteEnvelope, ProjectEnvelope, ProjectListEnvelope } from "@expand/cli/contract/project/envelope"
import { HealthEnvelope } from "@expand/cli/contract/server/envelope"

const shapeOf = (schema: Schema.Top): unknown => Schema.toJsonSchemaDocument(schema)

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
