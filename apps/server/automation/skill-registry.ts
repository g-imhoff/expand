import { Effect } from "effect"
import { AutomationError, decodeJson } from "@expand/contracts/automation"
import type { ContextFreeCodec } from "@expand/contracts/automation"

export interface SkillDefinition {
  readonly id: string
  readonly version: number
  readonly title: string
  readonly description: string
  readonly inputSchema: ContextFreeCodec
  readonly requiredCapabilities: ReadonlyArray<string>
  readonly allowedPaths: ReadonlyArray<string>
  readonly buildPrompt: (inputs: unknown) => string
}

export interface SkillCheckOutcome {
  readonly check: string
  readonly passed: boolean
  readonly detail?: string
}

export {
  resolveSkill,
  decodeSkillInputs,
  evaluateCompletionChecks,
  allowedPathsCheck
}

const resolveSkill = (
  skills: ReadonlyArray<SkillDefinition>,
  skillId: string
): Effect.Effect<SkillDefinition, AutomationError> =>
  Effect.gen(function*() {
    const found = skills.find((skill) => skill.id === skillId)
    if (found === undefined) {
      return yield* new AutomationError({ code: "missing-definition", message: `Unknown skill: ${skillId}` })
    }
    return found
  })

const decodeSkillInputs = (skill: SkillDefinition, inputs: unknown): Effect.Effect<unknown, AutomationError> =>
  decodeJson(skill.inputSchema, inputs).pipe(
    Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: `Skill inputs do not match ${skill.id}` }))
  )

const evaluateCompletionChecks = (
  skill: SkillDefinition,
  outcome: { readonly transcript: ReadonlyArray<string>; readonly diffSummary: string; readonly exitStatus: number }
): Array<SkillCheckOutcome> => {
  const primary = skill.allowedPaths[0] ?? ""
  const transcript = [...outcome.transcript].join("\n")
  const exitCheck: SkillCheckOutcome = outcome.exitStatus === 0
    ? { check: "exit-zero", passed: true }
    : { check: "exit-zero", passed: false, detail: `exit ${outcome.exitStatus}` }
  const diffCheck: SkillCheckOutcome = outcome.diffSummary.trim().length > 0
    ? { check: "diff-not-empty", passed: true }
    : { check: "diff-not-empty", passed: false, detail: "empty diff" }
  const allowed = allowedPathsCheck(skill.allowedPaths, outcome.diffSummary)
  const allowedSet = new Set<string>()
  for (const entry of skill.allowedPaths) {
    const normalized = normalizeRepoPath(entry)
    if (normalized !== null) {
      allowedSet.add(normalized)
    }
  }
  const changed = changedPaths(outcome.diffSummary)
  let coupled = false
  for (const entry of allowedSet) {
    if (transcript.includes(`wrote ${entry}`) && changed.has(entry)) {
      coupled = true
      break
    }
  }
  const writeCheck: SkillCheckOutcome = primary.length > 0 && coupled
    ? { check: "transcript-contains-write", passed: true }
    : { check: "transcript-contains-write", passed: false, detail: `missing wrote ${primary}` }
  return [exitCheck, diffCheck, allowed, writeCheck]
}

const allowedPathsCheck = (allowedPaths: ReadonlyArray<string>, diffSummary: string): SkillCheckOutcome => {
  const allowed = new Set<string>()
  for (const entry of allowedPaths) {
    const normalized = normalizeRepoPath(entry)
    if (normalized !== null) {
      allowed.add(normalized)
    }
  }
  const changed = extractChangedPaths(diffSummary)
  if (changed.length === 0) {
    return { check: "diff-only-allowed-paths", passed: false, detail: "no changed file detected" }
  }
  const outside = changed.filter((entry) => entry.normalized === null || !allowed.has(entry.normalized))
  if (outside.length > 0) {
    return { check: "diff-only-allowed-paths", passed: false, detail: `outside allowed paths: ${outside.map((entry) => entry.normalized ?? entry.raw).join(",")}` }
  }
  return { check: "diff-only-allowed-paths", passed: true }
}

interface ChangedPath {
  readonly raw: string
  readonly normalized: string | null
}

const changedPaths = (diffSummary: string): Set<string> => {
  const paths = new Set<string>()
  for (const entry of extractChangedPaths(diffSummary)) {
    if (entry.normalized !== null) {
      paths.add(entry.normalized)
    }
  }
  return paths
}

const normalizeRepoPath = (raw: string): string | null => {
  let value = raw.trim()
  if (value.length === 0) {
    return null
  }
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim()
  }
  while (value.startsWith("./")) {
    value = value.slice(2)
  }
  value = value.trim()
  if (value.length === 0) {
    return null
  }
  if (value.startsWith("/")) {
    return null
  }
  const parts = value.split("/")
  const cleaned: Array<string> = []
  for (const part of parts) {
    if (part.length === 0 || part === ".") {
      continue
    }
    if (part === "..") {
      return null
    }
    cleaned.push(part)
  }
  if (cleaned.length === 0) {
    return null
  }
  return cleaned.join("/")
}

const extractChangedPaths = (diffSummary: string): Array<ChangedPath> => {
  const found: Array<ChangedPath> = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      return
    }
    const normalized = normalizeRepoPath(trimmed)
    const key = normalized ?? `!${trimmed}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    found.push({ raw: trimmed, normalized })
  }
  const lines = diffSummary.split("\n")
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue
    }
    const porcelain = parsePorcelainTargets(line)
    if (porcelain !== undefined) {
      for (const target of porcelain) {
        if (target.length > 0) {
          push(target)
        }
      }
      continue
    }
    const stat = parseStatTargets(line)
    if (stat !== undefined) {
      for (const target of stat) {
        if (target.length > 0) {
          push(target)
        }
      }
    }
  }
  return found
}

const isPorcelainCode = (value: string): boolean => {
  return value === " " || value === "?" || value === "!" || value === "U" || (value >= "A" && value <= "Z")
}

const isRenameCopyStatus = (first: string, second: string): boolean => {
  return first === "R" || second === "R" || first === "C" || second === "C"
}

const splitRenameArrow = (value: string): Array<string> => {
  return value.split(" -> ").map((part) => part.trim()).filter((part) => part.length > 0)
}

const expandStatRename = (value: string): Array<string> => {
  const open = value.indexOf("{")
  const close = open >= 0 ? value.indexOf("}", open + 1) : -1
  if (open >= 0 && close > open) {
    const inside = value.slice(open + 1, close)
    const sep = inside.indexOf("=>")
    if (sep >= 0) {
      const pre = value.slice(0, open)
      const post = value.slice(close + 1)
      const leftPart = inside.slice(0, sep).trim()
      const rightPart = inside.slice(sep + 2).trim()
      const source = `${pre}${leftPart}${post}`.trim()
      const target = `${pre}${rightPart}${post}`.trim()
      const out: Array<string> = []
      for (const candidate of [source, target]) {
        if (candidate.length === 0) {
          continue
        }
        if (candidate.includes("=>")) {
          out.push(...expandStatRename(candidate))
        } else if (candidate.includes(" -> ")) {
          out.push(...splitRenameArrow(candidate))
        } else {
          out.push(candidate)
        }
      }
      return out
    }
  }
  return value.split("=>").map((part) => part.trim()).filter((part) => part.length > 0)
}

const parsePorcelainTargets = (line: string): Array<string> | undefined => {
  if (line.length < 4) {
    return undefined
  }
  const first = line[0] ?? ""
  const second = line[1] ?? ""
  const third = line[2] ?? ""
  if (third !== " ") {
    return undefined
  }
  if (!isPorcelainCode(first) || !isPorcelainCode(second)) {
    return undefined
  }
  const raw = line.slice(3).trim()
  if (raw.length === 0) {
    return undefined
  }
  if (isRenameCopyStatus(first, second)) {
    if (raw.includes(" -> ")) {
      const parts = splitRenameArrow(raw)
      if (parts.length > 0) {
        return parts
      }
      return []
    }
    return [raw]
  }
  return [raw]
}

const parseStatTargets = (line: string): Array<string> | undefined => {
  const bar = line.indexOf("|")
  if (bar < 0) {
    return undefined
  }
  const left = line.slice(0, bar).trim()
  if (left.length === 0) {
    return undefined
  }
  if (left.includes("=>")) {
    const expanded = expandStatRename(left)
    if (expanded.length > 0) {
      return expanded
    }
    return []
  }
  if (left.includes(" -> ")) {
    const parts = splitRenameArrow(left)
    if (parts.length > 0) {
      return parts
    }
    return []
  }
  return [left]
}
