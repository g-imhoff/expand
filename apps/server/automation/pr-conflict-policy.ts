import { Effect, Schema } from "effect"
import { AutomationError } from "@expand/contracts/automation"
import { GithubPrConflictPayload } from "@expand/contracts/automation/conflicts"

export interface ConflictBranchPolicy {
  readonly permittedBranches: ReadonlyArray<string>
  readonly protectedBranches: ReadonlyArray<string>
  readonly defaultBranch: string
}

export const normalizeBranch = (branch: string): string | null => {
  const value = branch.trim()
  if (value.length === 0) return null
  if (value.startsWith("/")) return null
  if (value.includes("..") || value.includes("\0")) return null
  const parts = value.split("/")
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === "..") return null
  }
  return value
}

export const matchesPrefixList = (branch: string, prefixes: ReadonlyArray<string>): boolean => {
  for (const prefix of prefixes) {
    if (prefix.endsWith("/") && branch.startsWith(prefix)) return true
    if (!prefix.endsWith("/") && branch === prefix) return true
  }
  return false
}

export const isProtectedBranch = (branch: string, protectedBranches: ReadonlyArray<string>, defaultBranch: string): boolean => {
  if (branch === defaultBranch) return true
  return matchesPrefixList(branch, protectedBranches) || protectedBranches.includes(branch)
}

export const isPermittedBranch = (branch: string, policy: ConflictBranchPolicy): boolean => {
  const normalized = normalizeBranch(branch)
  if (normalized === null) return false
  if (isProtectedBranch(normalized, policy.protectedBranches, policy.defaultBranch)) return false
  if (policy.permittedBranches.length === 0) return false
  return matchesPrefixList(normalized, policy.permittedBranches) || policy.permittedBranches.includes(normalized)
}

export type Mergeability = "conflicted" | "clean" | "unknown"

export const classifyMergeability = (input: { readonly mergeable: boolean | null | undefined; readonly mergeableState?: string | null | undefined }): Mergeability => {
  if (input.mergeable === false) return "conflicted"
  if (typeof input.mergeableState === "string") {
    const state = input.mergeableState.toLowerCase()
    if (state === "dirty") return "conflicted"
    if (state === "clean" || state === "has_hooks" || state === "unstable") return "clean"
    if (state === "unknown" || state === "blocked") return "unknown"
  }
  if (input.mergeable === true) return "clean"
  return "unknown"
}

export const shouldAttemptResolution = (payload: typeof GithubPrConflictPayload.Type, policy: ConflictBranchPolicy): boolean => {
  if (payload.mergeable !== false) return false
  if (!isPermittedBranch(payload.headBranch, policy)) return false
  return true
}

export const decodeConflictPayload = (value: unknown): Effect.Effect<typeof GithubPrConflictPayload.Type, AutomationError> =>
  Schema.decodeUnknownEffect(GithubPrConflictPayload, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: "PR conflict payload is not usable" }))
  )

export const toUnresolvedReason = (kind: "protected-branch" | "default-branch" | "not-conflicted" | "unvalidated" | "check-failed", detail: string): string => {
  const safe = detail.trim().slice(0, 200)
  return safe.length > 0 ? `${kind}:${safe}` : kind
}
