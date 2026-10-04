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

export const skillKey = (id: string, version: number): string => `${id}@${version}`

export const resolveSkill = (
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

export const decodeSkillInputs = (skill: SkillDefinition, inputs: unknown): Effect.Effect<unknown, AutomationError> =>
  decodeJson(skill.inputSchema, inputs).pipe(
    Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: `Skill inputs do not match ${skill.id}` }))
  )

export const evaluateCompletionChecks = (
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
  const writeCheck: SkillCheckOutcome = primary.length > 0 && transcript.includes(`wrote ${primary}`)
    ? { check: "transcript-contains-write", passed: true }
    : { check: "transcript-contains-write", passed: false, detail: `missing wrote ${primary}` }
  return [exitCheck, diffCheck, allowed, writeCheck]
}

export const allowedPathsCheck = (allowedPaths: ReadonlyArray<string>, diffSummary: string): SkillCheckOutcome => {
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
    const porcelain = parsePorcelainTarget(line)
    if (porcelain !== undefined) {
      if (porcelain.length > 0) {
        push(porcelain)
      }
      continue
    }
    const stat = parseStatTarget(line)
    if (stat !== undefined && stat.length > 0) {
      push(stat)
    }
  }
  return found
}

const isPorcelainCode = (value: string): boolean => {
  return value === " " || value === "?" || value === "!" || value === "U" || (value >= "A" && value <= "Z")
}

const stripRenameTarget = (value: string): string => {
  const arrow = value.lastIndexOf(" -> ")
  if (arrow >= 0) {
    return value.slice(arrow + 4).trim()
  }
  const fat = value.lastIndexOf("=>")
  if (fat >= 0) {
    return value.slice(fat + 2).trim().replace(/^[{\s]+/, "").replace(/[\s}]+$/, "").trim()
  }
  return value
}

const parsePorcelainTarget = (line: string): string | undefined => {
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
  let raw = line.slice(3).trim()
  if (raw.length === 0) {
    return undefined
  }
  raw = stripRenameTarget(raw)
  if (raw.length === 0) {
    return undefined
  }
  return raw
}

const parseStatTarget = (line: string): string | undefined => {
  const bar = line.indexOf("|")
  if (bar < 0) {
    return undefined
  }
  let left = line.slice(0, bar).trim()
  if (left.length === 0) {
    return undefined
  }
  left = stripRenameTarget(left).replace(/^[{\s]+/, "").replace(/[\s}]+$/, "").trim()
  if (left.length === 0) {
    return undefined
  }
  return left
}
