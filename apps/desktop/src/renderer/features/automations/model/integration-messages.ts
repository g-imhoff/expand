import type { PersonalScope } from "@expand/contracts/automation"
import type { GithubConnectionStatus } from "@expand/contracts/rpc/automation-schemas"

export const githubCredentialId = "github-token"
export const zenCredentialId = "zen-api-key"
export const githubIntegrationId = "github"

export const automationScopeForProject = (projectId: string): PersonalScope => ({
  ownerId: localOwnerId,
  projectId
})

export const formatStatusFlag = (value: boolean | undefined): string => {
  if (value === undefined) return "unknown"
  return value ? "yes" : "no"
}

export const formatLabelsCount = (labels: number | undefined): string => {
  if (labels === undefined) return "unknown"
  return String(labels)
}

export const describeAutomationError = (error: unknown): string => {
  const code = readErrorCode(error)
  if (code !== undefined) {
    const problem = describeProblemCode(code)
    if (problem !== undefined) return problem
  }
  if (readTag(error) === "AutomationNotFound") {
    return "This integration is not configured yet. Save the connection below to set it up."
  }
  const message = readMessage(error)
  if (message !== undefined && message.length > 0) return message
  return "The automation service reported an error. Try again."
}

export const describeConnectionStatus = (status: GithubConnectionStatus): string => {
  if (status.ok) return "Connected. GitHub is reachable and the credential was accepted."
  if (status.code !== undefined) {
    const problem = describeProblemCode(status.code)
    if (problem !== undefined) return problem
  }
  if (status.reason !== undefined && status.reason.length > 0) return status.reason
  if (status.configured === false) return "No credential is saved for this integration. Enter the secret below and choose Save to store it."
  return "The connection test failed. Check the repository and credential, then try again."
}

export const describeZenStatus = (configured: boolean): string => {
  if (configured) return "A Zen API key is saved for this project. Tests use the saved key without displaying it."
  return "No Zen API key is saved yet. Paste the key below and choose Save to store it."
}

const localOwnerId = "local"

const describeProblemCode = (code: string): string | undefined => {
  switch (code) {
    case "missing-credential":
      return "No credential is saved for this integration. Enter the secret below and choose Save to store it."
    case "invalid-credential":
    case "invalid-contract":
      return "The saved configuration was rejected. Check the repository names, save again, then test the connection."
    case "auth":
      return "The saved credential was rejected. Create a new token with the required scopes, save it again, then test the connection."
    case "connection":
    case "connection-failed":
      return "The backend could not reach the service. Check your network connection and try again."
    case "rate-limited":
      return "The service rate limit is exhausted. Wait for the limit to reset, then test the connection again."
    case "forbidden":
    case "not-allowed":
      return "The credential lacks the required access. Issue a token with repository and label scopes, save it, then test again."
    case "not-found":
      return "The backend could not find the requested repository. Check the owner and repository names."
    case "missing":
      return "This integration is not configured yet. Save the connection below to set it up."
    default:
      return undefined
  }
}

const readTag = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const tag = (error as { readonly _tag?: unknown })._tag
  return typeof tag === "string" ? tag : undefined
}

const readErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

const readMessage = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const message = (error as { readonly message?: unknown }).message
  return typeof message === "string" ? message : undefined
}
