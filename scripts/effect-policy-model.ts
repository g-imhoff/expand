import { Schema } from "effect"

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export class SourceIdentity extends Schema.Class<SourceIdentity>("SourceIdentity")({
  file: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt
}) {}

export class HostBoundary extends Schema.Class<HostBoundary>("HostBoundary")({
  file: Schema.String,
  declaration: Schema.String,
  host: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt
}) {}
