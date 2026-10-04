import { Context, Effect, Layer, Stream } from "effect"
import type { RpcClientError } from "effect/rpc"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import type { Catalog, PersonalScope } from "@expand/contracts/automation"
import { PreviewIssue } from "@expand/contracts/rpc/automation-schemas"
import type {
  AutomationConflict,
  AutomationInvalid,
  AutomationNotFound,
  AutomationStorageFailed,
  CredentialStatus,
  GithubConnectionStatus,
  IntegrationRecord,
  PreviewOutcome,
  RoutineHead,
  RoutineRecord,
  RunHistory,
  RunMetrics,
  RunPage
} from "@expand/contracts/rpc/automation-schemas"
import type { DefinitionReference, IntegrationConfiguration, JevDecisionResult, JsonValue, ProcessDefinition } from "@expand/contracts/automation"
import { RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"


export interface AutomationRpcApi {
  readonly createRoutine: (payload: {
    readonly scope: PersonalScope
    readonly routineId: string
    readonly template?: DefinitionReference
    readonly configuration: JsonValue
    readonly integrations: ReadonlyArray<IntegrationConfiguration>
    readonly process: ProcessDefinition
  }) => Effect.Effect<{ readonly revision: number }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly listRoutines: (payload: { readonly scope: PersonalScope }) => Effect.Effect<{ readonly routines: ReadonlyArray<RoutineRecord> }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly getRoutine: (payload: { readonly scope: PersonalScope; readonly routineId: string }) => Effect.Effect<RoutineRecord, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
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
  readonly putCredential: (payload: { readonly scope: PersonalScope; readonly credentialId: string; readonly secret: string; readonly expectedVersion?: number }) => Effect.Effect<CredentialStatus, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly removeCredential: (payload: { readonly scope: PersonalScope; readonly credentialId: string; readonly expectedVersion: number }) => Effect.Effect<{ readonly removed: true }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly listCredentials: (payload: { readonly scope: PersonalScope }) => Effect.Effect<{ readonly credentials: ReadonlyArray<CredentialStatus> }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly putIntegration: (payload: { readonly scope: PersonalScope; readonly integration: IntegrationConfiguration; readonly expectedVersion?: number }) => Effect.Effect<{ readonly version: number }, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly getIntegration: (payload: { readonly scope: PersonalScope; readonly integrationId: string }) => Effect.Effect<IntegrationRecord, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly integrationStatus: (payload: { readonly scope: PersonalScope; readonly integrationId: string }) => Effect.Effect<GithubConnectionStatus, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly preview: (payload: {
    readonly scope: PersonalScope
    readonly routineId?: string
    readonly inline?: {
      readonly routineId: string
      readonly template?: DefinitionReference
      readonly configuration: JsonValue
      readonly integrations: ReadonlyArray<IntegrationConfiguration>
      readonly process: ProcessDefinition
    }
    readonly issue: typeof PreviewIssue.Type
    readonly decision: JevDecisionResult
  }) => Effect.Effect<PreviewOutcome, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly listRuns: (payload: {
    readonly scope: PersonalScope
    readonly limit: number
    readonly cursor?: string
    readonly routineId?: string
    readonly mode?: "preview" | "live"
    readonly state?: "queued" | "running" | "succeeded" | "unresolved" | "failed" | "cancelled"
  }) => Effect.Effect<RunPage, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly getRun: (payload: { readonly scope: PersonalScope; readonly runId: string }) => Effect.Effect<RunHistory, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly metrics: (payload: { readonly scope: PersonalScope; readonly routineId?: string; readonly mode?: "preview" | "live" }) => Effect.Effect<RunMetrics, RpcClientError.RpcClientError | AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed>
  readonly catalog: () => Effect.Effect<Catalog, RpcClientError.RpcClientError>
  readonly events: (payload: { readonly fromSeq?: number }) => Stream.Stream<SequencedEvent, RpcClientError.RpcClientError>
}

export class AutomationRpc extends Context.Service<AutomationRpc, AutomationRpcApi>()(
  "expand/desktop/AutomationRpc"
) {}

export const AutomationRpcLayer: Layer.Layer<AutomationRpc, never, RendererRpcClient> = Layer.effect(
  AutomationRpc,
  Effect.map(RendererRpcClient, (client): AutomationRpcApi => ({
    createRoutine: (p) => client.AutomationRoutineCreate(p),
    listRoutines: (p) => client.AutomationRoutineList(p),
    getRoutine: (p) => client.AutomationRoutineGet(p),
    editRoutine: (p) => client.AutomationRoutineEdit(p),
    enableRoutine: (p) => client.AutomationRoutineEnable(p),
    pauseRoutine: (p) => client.AutomationRoutinePause(p),
    deleteRoutine: (p) => client.AutomationRoutineDelete(p),
    putCredential: (p) => client.AutomationCredentialPut(p),
    removeCredential: (p) => client.AutomationCredentialRemove(p),
    listCredentials: (p) => client.AutomationCredentialList(p),
    putIntegration: (p) => client.AutomationIntegrationPut(p),
    getIntegration: (p) => client.AutomationIntegrationGet(p),
    integrationStatus: (p) => client.AutomationIntegrationStatus(p),
    preview: (p) => client.AutomationPreviewClassification(p),
    listRuns: (p) => client.AutomationRunList(p),
    getRun: (p) => client.AutomationRunGet(p),
    metrics: (p) => client.AutomationRunMetrics(p),
    catalog: () => client.AutomationCatalog({}),
    events: (payload) => client.Events(payload)
  }))
)
