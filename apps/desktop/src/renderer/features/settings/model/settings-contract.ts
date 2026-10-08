export interface ScopeCheck {
  readonly scope: string
  readonly granted: boolean
}

export interface GithubConnectionModel {
  readonly kind: "github"
  readonly health: ConnectionHealth
  readonly accountName: string | null
  readonly scopes: ReadonlyArray<ScopeCheck>
  readonly canPushToGh: boolean
  readonly isBusy: boolean
}

export interface ZenConnectionModel {
  readonly kind: "zen"
  readonly health: ConnectionHealth
  readonly keySaved: boolean
  readonly isBusy: boolean
}

export interface ConnectionSettingsModel {
  readonly status: "loading" | "ready" | "error"
  readonly error: string | null
  readonly github: GithubConnectionModel
  readonly zen: ZenConnectionModel
  readonly backendName: string
}

export interface FeatureCredentialSeamModel {
  readonly connected: boolean
  readonly featureName: string
  readonly returnTarget: string
}

export type ConnectionHealth = "healthy" | "degraded" | "missing" | "unknown"
