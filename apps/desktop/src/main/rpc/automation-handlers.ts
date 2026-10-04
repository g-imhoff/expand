import { Effect } from "effect"
import type { RpcGroup } from "effect/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { AutomationClient } from "@expand/client-ts/automation"
import { dieOnRpcClientError } from "@expand/desktop/main/rpc/guard"

export const automationHandlers: Pick<
  Handlers,
  | "AutomationRoutineCreate"
  | "AutomationRoutineEdit"
  | "AutomationRoutineEnable"
  | "AutomationRoutinePause"
  | "AutomationRoutineDelete"
  | "AutomationRoutineGet"
  | "AutomationRoutineList"
  | "AutomationIntegrationPut"
  | "AutomationIntegrationGet"
  | "AutomationIntegrationStatus"
  | "AutomationCredentialPut"
  | "AutomationCredentialRemove"
  | "AutomationCredentialList"
  | "AutomationPreviewClassification"
  | "AutomationRoutineStart"
  | "AutomationRunList"
  | "AutomationRunGet"
  | "AutomationRunMetrics"
  | "AutomationCatalog"
> = {
  AutomationRoutineCreate: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.createRoutine(payload))),
  AutomationRoutineEdit: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.editRoutine(payload))),
  AutomationRoutineEnable: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.enableRoutine(payload))),
  AutomationRoutinePause: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.pauseRoutine(payload))),
  AutomationRoutineDelete: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.deleteRoutine(payload))),
  AutomationRoutineGet: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.getRoutine(payload))),
  AutomationRoutineList: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.listRoutines(payload))),
  AutomationIntegrationPut: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.putIntegration(payload))),
  AutomationIntegrationGet: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.getIntegration(payload))),
  AutomationIntegrationStatus: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.integrationStatus(payload))),
  AutomationCredentialPut: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.putCredential(payload))),
  AutomationCredentialRemove: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.removeCredential(payload))),
  AutomationCredentialList: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.listCredentials(payload))),
  AutomationPreviewClassification: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.previewClassification(payload))),
  AutomationRoutineStart: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.startRoutine(payload))),
  AutomationRunList: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.listRuns(payload))),
  AutomationRunGet: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.getRun(payload))),
  AutomationRunMetrics: (payload) =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.runMetrics(payload))),
  AutomationCatalog: () =>
    dieOnRpcClientError(Effect.flatMap(AutomationClient, (client) => client.catalog()))
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
