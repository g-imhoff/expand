import { Schema } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/version"

export class HealthEnvelope extends Schema.Opaque<HealthEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(ENVELOPE_VERSION),
    kind: Schema.Literal("ServerHealth"),
    data: Schema.Struct({ status: Schema.String })
  })
) {}
