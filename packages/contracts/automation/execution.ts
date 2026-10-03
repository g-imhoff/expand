import { Schema } from "effect"
import { AutomationFailure, JsonValue } from "./descriptors.js"
import { ConfigurationReference, DefinitionReference, IntegrationReference, LocalId, PersonalScope, PositiveVersion } from "./ids.js"
import { ActionOutcome, JevDecisionRequest, JevDecisionResult, RunState } from "./run.js"

export const Delivery = Schema.Struct({ schemaVersion: Schema.Literal(1), id: LocalId, scope: PersonalScope, integration: IntegrationReference, externalId: LocalId, trigger: DefinitionReference, payload: JsonValue })
export type Delivery = typeof Delivery.Type
export const Job = Schema.Struct({ id: LocalId, scope: PersonalScope, runId: LocalId, configuration: ConfigurationReference, inputId: LocalId, mode: Schema.Literals(["preview", "live"]), state: RunState, metadata: JsonValue })
export type Job = typeof Job.Type
export const Attempt = Schema.Union([
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("job"), status: Schema.Literal("started"), request: JsonValue }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("job"), status: Schema.Literal("completed"), request: JsonValue, completion: completionSchema() }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("decision"), status: Schema.Literal("started"), request: JevDecisionRequest }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("decision"), status: Schema.Literal("completed"), request: JevDecisionRequest, finishedAt: LocalId, result: Schema.optional(JevDecisionResult), error: Schema.optional(AutomationFailure) }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("action"), status: Schema.Literal("started"), integration: IntegrationReference, action: DefinitionReference, arguments: JsonValue }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("action"), status: Schema.Literal("completed"), integration: IntegrationReference, action: DefinitionReference, arguments: JsonValue, finishedAt: LocalId, outcome: ActionOutcome })
])
export type Attempt = typeof Attempt.Type
export const RoutineStatus = Schema.Literals(["enabled", "paused", "deleted"])
export type RoutineStatus = typeof RoutineStatus.Type
export const CredentialStatus = Schema.Struct({
  credentialId: LocalId, version: PositiveVersion, configured: Schema.Literal(true)
})
export type CredentialStatus = typeof CredentialStatus.Type

function attemptBase() { return { id: LocalId, scope: PersonalScope, runId: LocalId, jobId: LocalId, stepId: LocalId, attempt: PositiveVersion, startedAt: LocalId } }
function completionSchema() { return Schema.Struct({ finishedAt: LocalId, result: Schema.optional(JsonValue), error: Schema.optional(AutomationFailure) }) }
