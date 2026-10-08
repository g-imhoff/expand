import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect } from "effect"
import { classifyMergeability, isPermittedBranch, isProtectedBranch, shouldAttemptResolution } from "../../automation/pr-conflict-policy.js"

const policy = { permittedBranches: ["feature/"], protectedBranches: ["develop", "master", "main"], defaultBranch: "develop" }

describe("pr conflict policy", () => {
  it.effect("permits feature branches and blocks protected or default branches", () =>
    Effect.gen(function*() {
      expect(isPermittedBranch("feature/conflict-demo", policy)).toBe(true)
      expect(isPermittedBranch("develop", policy)).toBe(false)
      expect(isPermittedBranch("main", policy)).toBe(false)
      expect(isPermittedBranch("hotfix/urgent", policy)).toBe(false)
      expect(isProtectedBranch("develop", policy.protectedBranches, policy.defaultBranch)).toBe(true)
      expect(isProtectedBranch("feature/conflict-demo", policy.protectedBranches, policy.defaultBranch)).toBe(false)
    }))
  it.effect("classifies mergeability with bounded dirty and clean states", () =>
    Effect.gen(function*() {
      expect(classifyMergeability({ mergeable: false })).toBe("conflicted")
      expect(classifyMergeability({ mergeable: null, mergeableState: "dirty" })).toBe("conflicted")
      expect(classifyMergeability({ mergeable: true })).toBe("clean")
      expect(classifyMergeability({ mergeable: null, mergeableState: "clean" })).toBe("clean")
      expect(classifyMergeability({ mergeable: null, mergeableState: "unknown" })).toBe("unknown")
      expect(classifyMergeability({ mergeable: null })).toBe("unknown")
    }))
  it.effect("attempts only conflicted and permitted heads", () =>
    Effect.gen(function*() {
      expect(shouldAttemptResolution({ pullNumber: 7, headBranch: "feature/conflict-demo", baseBranch: "develop", headSha: "abc123", mergeable: false }, policy)).toBe(true)
      expect(shouldAttemptResolution({ pullNumber: 7, headBranch: "feature/conflict-demo", baseBranch: "develop", headSha: "abc123", mergeable: true }, policy)).toBe(false)
      expect(shouldAttemptResolution({ pullNumber: 7, headBranch: "develop", baseBranch: "main", headSha: "abc123", mergeable: false }, policy)).toBe(false)
    }))
})
