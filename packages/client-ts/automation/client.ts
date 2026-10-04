import { Context, Effect, Layer } from "effect"
import type { RpcClientError } from "effect/rpc"
import type {
  Catalog,
  DefinitionReference,
  IntegrationConfiguration,
  JevDecisionResult,
  JsonValue,
  PersonalScope,
  ProcessDefinition
} from "@expand/contracts/automation"
import { PreviewIssue } from "@expand/contracts/rpc/automation-schemas"
import type {
  AutomationConflict,
  AutomationInvalid,
  AutomationNotFound,
  AutomationStorageFailed,
  CredentialStatus,
  RoutineStartResult,
  GithubConnectionStatus,
  IntegrationRecord,
  PreviewOutcome,
  RoutineHead,
  RoutineRecord,
  RunHistory,
  RunMetrics,
  RunPage
} from "@expand/contracts/rpc/automation-schemas"
import { ClientSession } from "../client-session"


export interface AutomationClientApi {
  readonly createRoutine: (payload: {
    readonly scope: PersonalScope
    readonly routineId: string
    readonly template?: DefinitionReference
    readonly configuration: JsonValue
    readonly integrations: ReadonlyArray<IntegrationConfiguration>
    readonly process: ProcessDefinition
  }) => Effect.Effect<{ readonly revision: number }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly editRoutine: (payload: {
    readonly scope: PersonalScope
    readonly routineId: string
    readonly template?: DefinitionReference
    readonly configuration: JsonValue
    readonly integrations: ReadonlyArray<IntegrationConfiguration>
    readonly process: ProcessDefinition
  }) => Effect.Effect<{ readonly revision: number }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly enableRoutine: (payload: { readonly scope: PersonalScope; readonly routineId: string; readonly expectedVersion: number }) => Effect.Effect<RoutineHead, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly pauseRoutine: (payload: { readonly scope: PersonalScope; readonly routineId: string; readonly expectedVersion: number }) => Effect.Effect<RoutineHead, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly deleteRoutine: (payload: { readonly scope: PersonalScope; readonly routineId: string; readonly expectedVersion: number }) => Effect.Effect<RoutineHead, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly getRoutine: (payload: { readonly scope: PersonalScope; readonly routineId: string }) => Effect.Effect<RoutineRecord, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly listRoutines: (payload: { readonly scope: PersonalScope }) => Effect.Effect<{ readonly routines: ReadonlyArray<RoutineRecord> }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly putIntegration: (payload: { readonly scope: PersonalScope; readonly integration: IntegrationConfiguration; readonly expectedVersion?: number }) => Effect.Effect<{ readonly version: number }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly getIntegration: (payload: { readonly scope: PersonalScope; readonly integrationId: string }) => Effect.Effect<IntegrationRecord, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly integrationStatus: (payload: { readonly scope: PersonalScope; readonly integrationId: string }) => Effect.Effect<GithubConnectionStatus, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly putCredential: (payload: { readonly scope: PersonalScope; readonly credentialId: string; readonly secret: string; readonly expectedVersion?: number }) => Effect.Effect<CredentialStatus, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly removeCredential: (payload: { readonly scope: PersonalScope; readonly credentialId: string; readonly expectedVersion: number }) => Effect.Effect<{ readonly removed: true }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly listCredentials: (payload: { readonly scope: PersonalScope }) => Effect.Effect<{ readonly credentials: ReadonlyArray<CredentialStatus> }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly previewClassification: (payload: {
    readonly scope: PersonalScope
    readonly routineId?: string
    readonly inline?: { readonly routineId: string; readonly template?: DefinitionReference; readonly configuration: JsonValue; readonly integrations: ReadonlyArray<IntegrationConfiguration>; readonly process: ProcessDefinition }
    readonly issue: typeof PreviewIssue.Type
    readonly decision: JevDecisionResult
  }) => Effect.Effect<PreviewOutcome, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly startRoutine: (payload: {
    readonly scope: PersonalScope
    readonly routineId: string
    readonly payload: JsonValue
    readonly idempotencyKey: string
  }) => Effect.Effect<RoutineStartResult, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly listRuns: (payload: {
    readonly scope: PersonalScope
    readonly limit: number
    readonly cursor?: string
    readonly routineId?: string
    readonly mode?: "preview" | "live"
    readonly state?: "queued" | "running" | "succeeded" | "unresolved" | "failed" | "cancelled"
  }) => Effect.Effect<RunPage, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly getRun: (payload: { readonly scope: PersonalScope; readonly runId: string }) => Effect.Effect<RunHistory, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly runMetrics: (payload: { readonly scope: PersonalScope; readonly routineId?: string; readonly mode?: "preview" | "live" }) => Effect.Effect<RunMetrics, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly catalog: () => Effect.Effect<Catalog, RpcClientError.RpcClientError>
}

export class AutomationClient extends Context.Service<AutomationClient, AutomationClientApi>()(
  "expand/AutomationClient"
) { }

export const AutomationClientLive: Layer.Layer<AutomationClient, never, ClientSession> = Layer.effect(
  AutomationClient,
  Effect.map(ClientSession, (session): AutomationClientApi => ({
    createRoutine: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineCreate(payload)),
    editRoutine: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineEdit(payload)),
    enableRoutine: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineEnable(payload)),
    pauseRoutine: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutinePause(payload)),
    deleteRoutine: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineDelete(payload)),
    getRoutine: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineGet(payload)),
    listRoutines: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineList(payload)),
    putIntegration: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationIntegrationPut(payload)),
    getIntegration: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationIntegrationGet(payload)),
    integrationStatus: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationIntegrationStatus(payload)),
    putCredential: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationCredentialPut(payload)),
    removeCredential: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationCredentialRemove(payload)),
    listCredentials: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationCredentialList(payload)),
    previewClassification: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationPreviewClassification(payload)),
    startRoutine: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineStart(payload)),
    listRuns: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRunList(payload)),
    getRun: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRunGet(payload)),
    runMetrics: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRunMetrics(payload)),
    catalog: () =>
      Effect.flatMap(session.current, (client) => client.AutomationCatalog({}))
  }))
)
