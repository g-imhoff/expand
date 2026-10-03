import { Context, Effect, Layer, Stream } from "effect"
import type { RpcClientError } from "effect/rpc"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import type { Catalog, CredentialStatus, JevDecisionResult, JsonValue } from "@expand/contracts/automation"
import type { GithubStatus, IntegrationRecord, NotificationPage, NotificationRecord, PreviewOutcome, RoutineHead, RoutineRecord, RunHistory, RunMetrics, RunPage } from "@expand/contracts/rpc/automation-schemas"
import type { AutomationRpcError, RoutineWrite } from "@expand/client-ts/automation"
import { RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"

export interface AutomationRpcApi {
  readonly routineCreate: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId: string
  } & RoutineWrite) => Effect.Effect<{ readonly revision: number }, AutomationRpcError>
  readonly routineEdit: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId: string
  } & RoutineWrite) => Effect.Effect<{ readonly revision: number }, AutomationRpcError>
  readonly routineEnable: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId: string
    readonly expectedVersion: number
  }) => Effect.Effect<RoutineHead, AutomationRpcError>
  readonly routinePause: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId: string
    readonly expectedVersion: number
  }) => Effect.Effect<RoutineHead, AutomationRpcError>
  readonly routineDelete: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId: string
    readonly expectedVersion: number
  }) => Effect.Effect<RoutineHead, AutomationRpcError>
  readonly routineGet: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId: string
  }) => Effect.Effect<RoutineRecord, AutomationRpcError>
  readonly routineList: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
  }) => Effect.Effect<{ readonly routines: ReadonlyArray<RoutineRecord> }, AutomationRpcError>
  readonly integrationPut: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly integration: IntegrationRecord["configuration"]
    readonly expectedVersion?: number
  }) => Effect.Effect<{ readonly version: number }, AutomationRpcError>
  readonly integrationGet: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly integrationId: string
  }) => Effect.Effect<IntegrationRecord, AutomationRpcError>
  readonly integrationStatus: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly integrationId: string
  }) => Effect.Effect<GithubStatus, AutomationRpcError>
  readonly credentialPut: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly credentialId: string
    readonly secret: JsonValue
    readonly expectedVersion?: number
  }) => Effect.Effect<CredentialStatus, AutomationRpcError>
  readonly credentialRemove: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly credentialId: string
    readonly expectedVersion: number
  }) => Effect.Effect<{ readonly removed: true }, AutomationRpcError>
  readonly credentialList: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
  }) => Effect.Effect<{ readonly credentials: ReadonlyArray<CredentialStatus> }, AutomationRpcError>
  readonly previewClassification: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId?: string
    readonly inline?: { readonly routineId: string } & RoutineWrite
    readonly issue: { readonly issueNumber: number; readonly title: string; readonly body?: string }
    readonly decision: JevDecisionResult
  }) => Effect.Effect<PreviewOutcome, AutomationRpcError>
  readonly runList: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly limit: number
    readonly cursor?: string
    readonly routineId?: string
    readonly mode?: "preview" | "live"
    readonly state?: "queued" | "running" | "succeeded" | "unresolved" | "failed" | "cancelled"
  }) => Effect.Effect<RunPage, AutomationRpcError>
  readonly runGet: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly runId: string
  }) => Effect.Effect<RunHistory, AutomationRpcError>
  readonly runMetrics: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly routineId?: string
    readonly mode?: "preview" | "live"
  }) => Effect.Effect<RunMetrics, AutomationRpcError>
  readonly notificationList: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly limit: number
    readonly status?: "pending" | "read"
  }) => Effect.Effect<NotificationPage, AutomationRpcError>
  readonly notificationMarkRead: (payload: {
    readonly scope: { readonly ownerId: string; readonly projectId: string }
    readonly runId: string
  }) => Effect.Effect<NotificationRecord, AutomationRpcError>
  readonly catalog: () => Effect.Effect<Catalog, RpcClientError.RpcClientError>
  readonly events: (
    payload: { readonly fromSeq: number }
  ) => Stream.Stream<SequencedEvent, RpcClientError.RpcClientError>
}

export class AutomationRpc extends Context.Service<AutomationRpc, AutomationRpcApi>()(
  "expand/desktop/AutomationRpc"
) {}

export const AutomationRpcLayer: Layer.Layer<AutomationRpc, never, RendererRpcClient> = Layer.effect(
  AutomationRpc,
  Effect.map(RendererRpcClient, (client): AutomationRpcApi => ({
    routineCreate: (p) => client.AutomationRoutineCreate(p),
    routineEdit: (p) => client.AutomationRoutineEdit(p),
    routineEnable: (p) => client.AutomationRoutineEnable(p),
    routinePause: (p) => client.AutomationRoutinePause(p),
    routineDelete: (p) => client.AutomationRoutineDelete(p),
    routineGet: (p) => client.AutomationRoutineGet(p),
    routineList: (p) => client.AutomationRoutineList(p),
    integrationPut: (p) => client.AutomationIntegrationPut(p),
    integrationGet: (p) => client.AutomationIntegrationGet(p),
    integrationStatus: (p) => client.AutomationIntegrationStatus(p),
    credentialPut: (p) => client.AutomationCredentialPut(p),
    credentialRemove: (p) => client.AutomationCredentialRemove(p),
    credentialList: (p) => client.AutomationCredentialList(p),
    previewClassification: (p) => client.AutomationPreviewClassification(p),
    runList: (p) => client.AutomationRunList(p),
    runGet: (p) => client.AutomationRunGet(p),
    runMetrics: (p) => client.AutomationRunMetrics(p),
    notificationList: (p) => client.AutomationNotificationList(p),
    notificationMarkRead: (p) => client.AutomationNotificationMarkRead(p),
    catalog: () => client.AutomationCatalog({}),
    events: (payload) => client.Events(payload)
  }))
)
