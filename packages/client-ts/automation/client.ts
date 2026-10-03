import { Context, Effect, Layer } from "effect"
import type { RpcClientError } from "effect/rpc"
import type {
  AutomationConflict,
  AutomationInvalid,
  AutomationNotFound,
  AutomationStorageFailed
} from "@expand/contracts/rpc/automation-schemas"
import type {
  GithubStatus,
  IntegrationRecord,
  ManualPreviewResult,
  ManualStartResult,
  NotificationPage,
  NotificationRecord,
  PreviewOutcome,
  RoutineHead,
  RoutineRecord,
  RunHistory,
  RunMetrics,
  RunPage
} from "@expand/contracts/rpc/automation-schemas"
import type { Catalog, CredentialStatus, DefinitionReference, IntegrationConfiguration, JevDecisionResult, JsonValue, PersonalScope, ProcessDefinition } from "@expand/contracts/automation"
import type { BackendUnavailable } from "../errors"
import type { RuntimeAdapter } from "../adapter"
import type { AppContext } from "@expand/contracts/app-context"
import type { ProcessControl } from "@expand/contracts/process-control"
import type { Crypto, FileSystem, Path } from "effect"
import { ClientSession, ClientSessionLayer } from "../client-session"

export interface RoutineWrite {
  readonly template?: DefinitionReference
  readonly configuration: JsonValue
  readonly integrations: ReadonlyArray<IntegrationConfiguration>
  readonly process: ProcessDefinition
}

export interface AutomationClientApi {
  readonly routineCreate: (payload: { readonly scope: PersonalScope; readonly routineId: string } & RoutineWrite) => Effect.Effect<{ readonly revision: number }, AutomationRpcError>
  readonly routineEdit: (payload: { readonly scope: PersonalScope; readonly routineId: string } & RoutineWrite) => Effect.Effect<{ readonly revision: number }, AutomationRpcError>
  readonly routineEnable: (payload: { readonly scope: PersonalScope; readonly routineId: string; readonly expectedVersion: number }) => Effect.Effect<RoutineHead, AutomationRpcError>
  readonly routinePause: (payload: { readonly scope: PersonalScope; readonly routineId: string; readonly expectedVersion: number }) => Effect.Effect<RoutineHead, AutomationRpcError>
  readonly routineDelete: (payload: { readonly scope: PersonalScope; readonly routineId: string; readonly expectedVersion: number }) => Effect.Effect<RoutineHead, AutomationRpcError>
  readonly routineGet: (payload: { readonly scope: PersonalScope; readonly routineId: string }) => Effect.Effect<RoutineRecord, AutomationRpcError>
  readonly routineList: (payload: { readonly scope: PersonalScope }) => Effect.Effect<{ readonly routines: ReadonlyArray<RoutineRecord> }, AutomationRpcError>
  readonly integrationPut: (payload: { readonly scope: PersonalScope; readonly integration: IntegrationConfiguration; readonly expectedVersion?: number }) => Effect.Effect<{ readonly version: number }, AutomationRpcError>
  readonly integrationGet: (payload: { readonly scope: PersonalScope; readonly integrationId: string }) => Effect.Effect<IntegrationRecord, AutomationRpcError>
  readonly integrationStatus: (payload: { readonly scope: PersonalScope; readonly integrationId: string }) => Effect.Effect<GithubStatus, AutomationRpcError>
  readonly credentialPut: (payload: { readonly scope: PersonalScope; readonly credentialId: string; readonly secret: JsonValue; readonly expectedVersion?: number }) => Effect.Effect<CredentialStatus, AutomationRpcError>
  readonly credentialRemove: (payload: { readonly scope: PersonalScope; readonly credentialId: string; readonly expectedVersion: number }) => Effect.Effect<{ readonly removed: true }, AutomationRpcError>
  readonly credentialList: (payload: { readonly scope: PersonalScope }) => Effect.Effect<{ readonly credentials: ReadonlyArray<CredentialStatus> }, AutomationRpcError>
  readonly previewClassification: (payload: {
    readonly scope: PersonalScope
    readonly routineId?: string
    readonly inline?: { readonly routineId: string } & RoutineWrite
    readonly issue: { readonly issueNumber: number; readonly title: string; readonly body?: string }
    readonly decision: JevDecisionResult
  }) => Effect.Effect<PreviewOutcome, AutomationRpcError>
  readonly runList: (payload: {
    readonly scope: PersonalScope
    readonly limit: number
    readonly cursor?: string
    readonly routineId?: string
    readonly mode?: "preview" | "live"
    readonly state?: "queued" | "running" | "succeeded" | "unresolved" | "failed" | "cancelled"
  }) => Effect.Effect<RunPage, AutomationRpcError>
  readonly runGet: (payload: { readonly scope: PersonalScope; readonly runId: string }) => Effect.Effect<RunHistory, AutomationRpcError>
  readonly runMetrics: (payload: { readonly scope: PersonalScope; readonly routineId?: string; readonly mode?: "preview" | "live" }) => Effect.Effect<RunMetrics, AutomationRpcError>
  readonly notificationList: (payload: {
    readonly scope: PersonalScope
    readonly limit: number
    readonly status?: "pending" | "read"
  }) => Effect.Effect<NotificationPage, AutomationRpcError>
  readonly notificationMarkRead: (payload: { readonly scope: PersonalScope; readonly runId: string }) => Effect.Effect<NotificationRecord, AutomationRpcError>
  readonly manualPreview: (payload: {
    readonly scope: PersonalScope
    readonly routineId: string
    readonly payload: JsonValue
    readonly decision?: JevDecisionResult
  }) => Effect.Effect<ManualPreviewResult, AutomationRpcError>
  readonly manualStart: (payload: {
    readonly scope: PersonalScope
    readonly routineId: string
    readonly deliveryId: string
    readonly payload: JsonValue
    readonly decision?: JevDecisionResult
    readonly mode?: "preview" | "live"
  }) => Effect.Effect<ManualStartResult, AutomationRpcError>
  readonly catalog: () => Effect.Effect<Catalog, RpcClientError.RpcClientError>
}

export class AutomationClient extends Context.Service<AutomationClient, AutomationClientApi>()(
  "expand/AutomationClient"
) { }

export type AutomationRpcError =
  | RpcClientError.RpcClientError
  | AutomationInvalid
  | AutomationConflict
  | AutomationNotFound
  | AutomationStorageFailed

/** @internal */
export const AutomationClientLive: Layer.Layer<AutomationClient, never, ClientSession> = Layer.effect(
  AutomationClient,
  Effect.map(ClientSession, (session): AutomationClientApi => ({
    routineCreate: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineCreate(payload)),
    routineEdit: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineEdit(payload)),
    routineEnable: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineEnable(payload)),
    routinePause: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutinePause(payload)),
    routineDelete: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineDelete(payload)),
    routineGet: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineGet(payload)),
    routineList: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRoutineList(payload)),
    integrationPut: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationIntegrationPut(payload)),
    integrationGet: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationIntegrationGet(payload)),
    integrationStatus: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationIntegrationStatus(payload)),
    credentialPut: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationCredentialPut(payload)),
    credentialRemove: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationCredentialRemove(payload)),
    credentialList: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationCredentialList(payload)),
    previewClassification: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationPreviewClassification(payload)),
    runList: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRunList(payload)),
    runGet: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRunGet(payload)),
    runMetrics: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationRunMetrics(payload)),
    notificationList: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationNotificationList(payload)),
    notificationMarkRead: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationNotificationMarkRead(payload)),
    manualPreview: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationManualPreview(payload)),
    manualStart: (payload) =>
      Effect.flatMap(session.current, (client) => client.AutomationManualStart(payload)),
    catalog: () =>
      Effect.flatMap(session.current, (client) => client.AutomationCatalog({}))
  }))
)

export const AutomationClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<
  AutomationClient,
  BackendUnavailable,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
> =>
  AutomationClientLive.pipe(Layer.provide(ClientSessionLayer(adapter)))
