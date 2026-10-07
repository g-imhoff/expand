import type { CredentialStatus, GithubConnectionStatus } from "@expand/contracts/rpc/automation-schemas"
import {
  useCredentialStatuses,
  useGithubStatusCheck,
  useZenConnect
} from "@expand/desktop/renderer/features/automations/data/use-integrations"
import { automationScopeForProject } from "@expand/desktop/renderer/features/automations/model/integration-messages"
import type { ConnectionSettingsModel } from "@expand/desktop/renderer/features/settings/model/settings-contract"

export interface ConnectionSettingsBinding {
  readonly model: ConnectionSettingsModel
  readonly saveZenKey: (key: string) => void
  readonly testConnection: (target: "github" | "zen") => void
  readonly retry: () => void
}

export const useConnectionSettings = (projectId: string): ConnectionSettingsBinding => {
  const scope = automationScopeForProject(projectId)
  const credentials = useCredentialStatuses(scope)
  const check = useGithubStatusCheck(scope)
  const zen = useZenConnect(scope)
  return {
    model: toConnectionSettingsModel({
      credentials: credentials.credentials,
      isLoading: credentials.isLoading || check.isStatusPending,
      error: credentials.error,
      unavailable: credentials.unavailable,
      status: check.status,
      zenBusy: zen.isConnectPending
    }),
    saveZenKey: (key) => zen.connect(key, { onSuccess: credentials.retry }),
    testConnection: (target) => {
      if (target === "github") {
        check.resetStatus()
        check.check()
        return
      }
      credentials.retry()
    },
    retry: () => {
      credentials.retry()
      check.resetStatus()
    }
  }
}

const toConnectionSettingsModel = (input: {
  readonly credentials: ReadonlyArray<CredentialStatus> | undefined
  readonly isLoading: boolean
  readonly error: unknown
  readonly unavailable: boolean
  readonly status: GithubConnectionStatus | undefined
  readonly zenBusy: boolean
}): ConnectionSettingsModel => {
  if (input.unavailable) {
    return {
      status: "error",
      error: "Automation services are unavailable in this session.",
      github: githubModel(undefined, undefined, false),
      zen: { kind: "zen", health: "unknown", keySaved: false, isBusy: input.zenBusy },
      backendName: "local"
    }
  }
  if (input.isLoading && input.credentials === undefined) {
    return {
      status: "loading",
      error: null,
      github: githubModel(undefined, undefined, false),
      zen: { kind: "zen", health: "unknown", keySaved: false, isBusy: input.zenBusy },
      backendName: "local"
    }
  }
  if (input.error !== undefined && input.credentials === undefined) {
    return {
      status: "error",
      error: "Connections could not be loaded.",
      github: githubModel(undefined, undefined, false),
      zen: { kind: "zen", health: "unknown", keySaved: false, isBusy: input.zenBusy },
      backendName: "local"
    }
  }
  const keySaved = input.credentials?.some((credential) => credential.credentialId === "zen-api-key" && credential.configured) ?? false
  return {
    status: "ready",
    error: null,
    github: githubModel(input.status, undefined, false),
    zen: {
      kind: "zen",
      health: keySaved ? "healthy" : "missing",
      keySaved,
      isBusy: input.zenBusy
    },
    backendName: "local"
  }
}

const githubModel = (
  status: GithubConnectionStatus | undefined,
  accountName: string | null | undefined,
  busy: boolean
): ConnectionSettingsModel["github"] => {
  if (status === undefined) {
    return { kind: "github", health: "unknown", accountName: accountName ?? null, scopes: [], canPushToGh: false, isBusy: busy }
  }
  return {
    kind: "github",
    health: status.ok ? "healthy" : status.configured ? "degraded" : "missing",
    accountName: accountName ?? null,
    scopes: [],
    canPushToGh: false,
    isBusy: busy
  }
}
