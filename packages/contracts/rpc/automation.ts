import { Rpc, RpcGroup } from "effect/rpc"
import { Schema } from "effect"
import {
  Catalog,
  DefinitionReference,
  IntegrationConfiguration,
  JevDecisionResult,
  JsonValue,
  LocalId,
  PersonalScope,
  PositiveVersion,
  ProcessDefinition
} from "@expand/contracts/automation"
import {
  AutomationErrorUnion,
  CredentialStatus,
  GithubConnectionStatus,
  IntegrationRecord,
  RoutineStartResult,
  PreviewIssue,
  PreviewOutcome,
  RoutineHead,
  RoutineRecord,
  RunHistory,
  RunMetrics,
  RunModeFilter,
  RunPage,
  RunStateFilter
} from "./automation-schemas.js"

export class AutomationRpcs extends RpcGroup.make(
  Rpc.make("AutomationRoutineCreate", {
    payload: {
      scope: PersonalScope,
      routineId: LocalId,
      template: Schema.optionalKey(DefinitionReference),
      configuration: JsonValue,
      integrations: Schema.Array(IntegrationConfiguration),
      process: ProcessDefinition
    },
    success: Schema.Struct({ revision: PositiveVersion }),
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRoutineEdit", {
    payload: {
      scope: PersonalScope,
      routineId: LocalId,
      template: Schema.optionalKey(DefinitionReference),
      configuration: JsonValue,
      integrations: Schema.Array(IntegrationConfiguration),
      process: ProcessDefinition
    },
    success: Schema.Struct({ revision: PositiveVersion }),
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRoutineEnable", {
    payload: { scope: PersonalScope, routineId: LocalId, expectedVersion: PositiveVersion },
    success: RoutineHead,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRoutinePause", {
    payload: { scope: PersonalScope, routineId: LocalId, expectedVersion: PositiveVersion },
    success: RoutineHead,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRoutineDelete", {
    payload: { scope: PersonalScope, routineId: LocalId, expectedVersion: PositiveVersion },
    success: RoutineHead,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRoutineGet", {
    payload: { scope: PersonalScope, routineId: LocalId },
    success: RoutineRecord,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRoutineList", {
    payload: { scope: PersonalScope },
    success: Schema.Struct({ routines: Schema.Array(RoutineRecord) }),
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationIntegrationPut", {
    payload: {
      scope: PersonalScope,
      integration: IntegrationConfiguration,
      expectedVersion: Schema.optionalKey(Schema.Int)
    },
    success: Schema.Struct({ version: PositiveVersion }),
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationIntegrationGet", {
    payload: { scope: PersonalScope, integrationId: LocalId },
    success: IntegrationRecord,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationIntegrationStatus", {
    payload: { scope: PersonalScope, integrationId: LocalId },
    success: GithubConnectionStatus,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationCredentialPut", {
    payload: {
      scope: PersonalScope,
      credentialId: LocalId,
      secret: Schema.String,
      expectedVersion: Schema.optionalKey(Schema.Int)
    },
    success: CredentialStatus,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationCredentialRemove", {
    payload: { scope: PersonalScope, credentialId: LocalId, expectedVersion: PositiveVersion },
    success: Schema.Struct({ removed: Schema.Literal(true) }),
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationCredentialList", {
    payload: { scope: PersonalScope },
    success: Schema.Struct({ credentials: Schema.Array(CredentialStatus) }),
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationPreviewClassification", {
    payload: Schema.Struct({
      scope: PersonalScope,
      routineId: Schema.optionalKey(LocalId),
      inline: Schema.optionalKey(Schema.Struct({
        routineId: LocalId,
        template: Schema.optionalKey(DefinitionReference),
        configuration: JsonValue,
        integrations: Schema.Array(IntegrationConfiguration),
        process: ProcessDefinition
      })),
      issue: PreviewIssue,
      decision: JevDecisionResult
    }).check(
      Schema.makeFilter(
        (p) => (p.routineId === undefined) !== (p.inline === undefined),
        { message: "exactly one of routineId or inline must be provided" }
      )
    ),
    success: PreviewOutcome,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRunList", {
    payload: {
      scope: PersonalScope,
      limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
      cursor: Schema.optionalKey(Schema.String),
      routineId: Schema.optionalKey(LocalId),
      mode: Schema.optionalKey(RunModeFilter),
      state: Schema.optionalKey(RunStateFilter)
    },
    success: RunPage,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRunGet", {
    payload: { scope: PersonalScope, runId: LocalId },
    success: RunHistory,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRunMetrics", {
    payload: {
      scope: PersonalScope,
      routineId: Schema.optionalKey(LocalId),
      mode: Schema.optionalKey(RunModeFilter)
    },
    success: RunMetrics,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationRoutineStart", {
    payload: {
      scope: PersonalScope,
      routineId: LocalId,
      payload: JsonValue,
      idempotencyKey: LocalId
    },
    success: RoutineStartResult,
    error: AutomationErrorUnion
  }),
  Rpc.make("AutomationCatalog", {
    payload: {},
    success: Catalog
  })
) { }
