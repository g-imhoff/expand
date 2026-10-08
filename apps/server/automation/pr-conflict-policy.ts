import { GithubPrConflictPayload } from "@expand/contracts/automation/conflicts"

export interface ConflictBranchPolicy {
  readonly permittedBranches: ReadonlyArray<string>
  readonly protectedBranches: ReadonlyArray<string>
  readonly defaultBranch: string
}

export {
  isProtectedBranch,
  isPermittedBranch,
  type Mergeability,
  classifyMergeability,
  shouldAttemptResolution
}

const normalizeBranch = (branch: string): string | null => {
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

const matchesPrefixList = (branch: string, prefixes: ReadonlyArray<string>): boolean => {
  for (const prefix of prefixes) {
    if (prefix.endsWith("/") && branch.startsWith(prefix)) return true
    if (!prefix.endsWith("/") && branch === prefix) return true
  }
  return false
}

const isProtectedBranch = (branch: string, protectedBranches: ReadonlyArray<string>, defaultBranch: string): boolean => {
  if (branch === defaultBranch) return true
  return matchesPrefixList(branch, protectedBranches) || protectedBranches.includes(branch)
}

const isPermittedBranch = (branch: string, policy: ConflictBranchPolicy): boolean => {
  const normalized = normalizeBranch(branch)
  if (normalized === null) return false
  if (isProtectedBranch(normalized, policy.protectedBranches, policy.defaultBranch)) return false
  if (policy.permittedBranches.length === 0) return false
  return matchesPrefixList(normalized, policy.permittedBranches) || policy.permittedBranches.includes(normalized)
}

type Mergeability = "conflicted" | "clean" | "unknown"

const classifyMergeability = (input: { readonly mergeable: boolean | null | undefined; readonly mergeableState?: string | null | undefined }): Mergeability => {
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

const shouldAttemptResolution = (payload: typeof GithubPrConflictPayload.Type, policy: ConflictBranchPolicy): boolean => {
  if (payload.mergeable !== false) return false
  if (!isPermittedBranch(payload.headBranch, policy)) return false
  return true
}
