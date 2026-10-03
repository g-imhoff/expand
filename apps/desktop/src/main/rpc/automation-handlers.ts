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
  | "AutomationRunList"
  | "AutomationRunGet"
  | "AutomationRunMetrics"
  | "AutomationCatalog"
> = {
  AutomationRoutineCreate: Effect.fn("DesktopRpc.AutomationRoutineCreate")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.routineCreate(payload))
    )
  ),
  AutomationRoutineEdit: Effect.fn("DesktopRpc.AutomationRoutineEdit")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.routineEdit(payload))
    )
  ),
  AutomationRoutineEnable: Effect.fn("DesktopRpc.AutomationRoutineEnable")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.routineEnable(payload))
    )
  ),
  AutomationRoutinePause: Effect.fn("DesktopRpc.AutomationRoutinePause")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.routinePause(payload))
    )
  ),
  AutomationRoutineDelete: Effect.fn("DesktopRpc.AutomationRoutineDelete")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.routineDelete(payload))
    )
  ),
  AutomationRoutineGet: Effect.fn("DesktopRpc.AutomationRoutineGet")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.routineGet(payload))
    )
  ),
  AutomationRoutineList: Effect.fn("DesktopRpc.AutomationRoutineList")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.routineList(payload))
    )
  ),
  AutomationIntegrationPut: Effect.fn("DesktopRpc.AutomationIntegrationPut")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.integrationPut(payload))
    )
  ),
  AutomationIntegrationGet: Effect.fn("DesktopRpc.AutomationIntegrationGet")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.integrationGet(payload))
    )
  ),
  AutomationIntegrationStatus: Effect.fn("DesktopRpc.AutomationIntegrationStatus")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.integrationStatus(payload))
    )
  ),
  AutomationCredentialPut: Effect.fn("DesktopRpc.AutomationCredentialPut")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.credentialPut(payload))
    )
  ),
  AutomationCredentialRemove: Effect.fn("DesktopRpc.AutomationCredentialRemove")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.credentialRemove(payload))
    )
  ),
  AutomationCredentialList: Effect.fn("DesktopRpc.AutomationCredentialList")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.credentialList(payload))
    )
  ),
  AutomationPreviewClassification: Effect.fn("DesktopRpc.AutomationPreviewClassification")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) =>
        client.previewClassification({
          scope: payload.scope,
          ...(payload.routineId === undefined ? {} : { routineId: payload.routineId }),
          ...(payload.inline === undefined ? {} : { inline: payload.inline }),
          issue: {
            issueNumber: payload.issue.issueNumber,
            title: payload.issue.title,
            ...(payload.issue.body === undefined ? {} : { body: payload.issue.body })
          },
          decision: payload.decision
        })
      )
    )
  ),
  AutomationRunList: Effect.fn("DesktopRpc.AutomationRunList")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.runList(payload))
    )
  ),
  AutomationRunGet: Effect.fn("DesktopRpc.AutomationRunGet")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.runGet(payload))
    )
  ),
  AutomationRunMetrics: Effect.fn("DesktopRpc.AutomationRunMetrics")((payload) =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.runMetrics(payload))
    )
  ),
  AutomationCatalog: Effect.fn("DesktopRpc.AutomationCatalog")(() =>
    dieOnRpcClientError(
      Effect.flatMap(AutomationClient, (client) => client.catalog())
    )
  )
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
