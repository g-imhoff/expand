import { globalCredentialScope } from "@expand/contracts/automation"
import type { CredentialStatus } from "@expand/contracts/rpc/automation-schemas"
import {
  useCredentialStatuses,
  useZenConnect
} from "@expand/desktop/renderer/features/automations/data/use-integrations"
import type { ConnectionSettingsModel } from "@expand/desktop/renderer/features/settings/model/settings-contract"

export interface ConnectionSettingsBinding {
  readonly model: ConnectionSettingsModel
  readonly saveZenKey: (key: string) => void
  readonly testConnection: (target: "github" | "zen") => void
  readonly retry: () => void
}

export const useConnectionSettings = (): ConnectionSettingsBinding => {
  const scope = globalCredentialScope("local")
  const credentials = useCredentialStatuses(scope)
  const zenVersion = credentials.credentials?.find((credential) => credential.credentialId === "zen-api-key")?.version ?? 0
  const zen = useZenConnect(scope, zenVersion)
  return {
    model: toConnectionSettingsModel({
      credentials: credentials.credentials,
      isLoading: credentials.isLoading,
      error: credentials.error,
      unavailable: credentials.unavailable,
      zenBusy: zen.isConnectPending
    }),
    saveZenKey: (key) => zen.connect(key, { onSuccess: credentials.retry }),
    testConnection: credentials.retry,
    retry: credentials.retry
  }
}

const toConnectionSettingsModel = (input: {
  readonly credentials: ReadonlyArray<CredentialStatus> | undefined
  readonly isLoading: boolean
  readonly error: unknown
  readonly unavailable: boolean
  readonly zenBusy: boolean
}): ConnectionSettingsModel => {
  if (input.unavailable) {
    return {
      status: "error",
      error: "Automation services are unavailable in this session.",
      github: githubModel(false),
      zen: { kind: "zen", health: "unknown", keySaved: false, isBusy: input.zenBusy },
      backendName: "local"
    }
  }
  if (input.isLoading && input.credentials === undefined) {
    return {
      status: "loading",
      error: null,
      github: githubModel(false),
      zen: { kind: "zen", health: "unknown", keySaved: false, isBusy: input.zenBusy },
      backendName: "local"
    }
  }
  if (input.error !== undefined && input.credentials === undefined) {
    return {
      status: "error",
      error: "Connections could not be loaded.",
      github: githubModel(false),
      zen: { kind: "zen", health: "unknown", keySaved: false, isBusy: input.zenBusy },
      backendName: "local"
    }
  }
  const keySaved = input.credentials?.some((credential) => credential.credentialId === "zen-api-key" && credential.configured) ?? false
  return {
    status: "ready",
    error: null,
    github: githubModel(input.credentials?.some((credential) => credential.credentialId === "github-token" && credential.configured) ?? false),
    zen: {
      kind: "zen",
      health: keySaved ? "healthy" : "missing",
      keySaved,
      isBusy: input.zenBusy
    },
    backendName: "local"
  }
}

const githubModel = (configured: boolean): ConnectionSettingsModel["github"] => ({
  kind: "github",
  health: configured ? "unknown" : "missing",
  accountName: null,
  scopes: [],
  canPushToGh: false,
  isBusy: false
})
