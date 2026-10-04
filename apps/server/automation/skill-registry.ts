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
  const allowed = new Set(allowedPaths.map((path) => baseName(path)))
  const mentioned = mentionedFileNames(diffSummary)
  if (mentioned.length === 0) {
    return { check: "diff-only-allowed-paths", passed: false, detail: "no changed file detected" }
  }
  const outside = mentioned.filter((name) => !allowed.has(name))
  if (outside.length > 0) {
    return { check: "diff-only-allowed-paths", passed: false, detail: `outside allowed paths: ${outside.join(",")}` }
  }
  return { check: "diff-only-allowed-paths", passed: true }
}

const baseName = (path: string): string => {
  const parts = path.split("/")
  return parts[parts.length - 1] ?? path
}

const mentionedFileNames = (diffSummary: string): Array<string> => {
  const found: Array<string> = []
  const seen = new Set<string>()
  const pattern = /[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(diffSummary)) !== null) {
    const token = match[0] ?? ""
    const name = baseName(token)
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    found.push(name)
  }
  return found
}
