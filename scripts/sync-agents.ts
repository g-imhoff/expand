import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Data, Effect, Exit, FileSystem, Path } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { parse as parseYaml } from "yaml"

export const AGENT_NAMES = [
  "code-reviewer",
  "task-reviewer",
  "desktop-tester",
  "manual-tester",
  "tdd-implementer",
  "researcher",
  "debugger"
] as const

export type AgentName = typeof AGENT_NAMES[number]

export interface AgentPolicy {
  readonly claudeModel: "claude-fable-5" | "claude-opus-4-8"
  readonly claudeEffort: "xhigh"
  readonly codexModel: "gpt-5.6-sol"
  readonly codexEffort: "medium" | "ultra"
  readonly sandboxMode: "read-only" | "workspace-write"
}

export const AGENT_POLICY: Readonly<Record<AgentName, AgentPolicy>> = {
  "code-reviewer": {
    claudeModel: "claude-fable-5",
    claudeEffort: "xhigh",
    codexModel: "gpt-5.6-sol",
    codexEffort: "ultra",
    sandboxMode: "read-only"
  },
  "task-reviewer": {
    claudeModel: "claude-fable-5",
    claudeEffort: "xhigh",
    codexModel: "gpt-5.6-sol",
    codexEffort: "ultra",
    sandboxMode: "read-only"
  },
  "desktop-tester": {
    claudeModel: "claude-opus-4-8",
    claudeEffort: "xhigh",
    codexModel: "gpt-5.6-sol",
    codexEffort: "medium",
    sandboxMode: "workspace-write"
  },
  "manual-tester": {
    claudeModel: "claude-opus-4-8",
    claudeEffort: "xhigh",
    codexModel: "gpt-5.6-sol",
    codexEffort: "medium",
    sandboxMode: "workspace-write"
  },
  "tdd-implementer": {
    claudeModel: "claude-opus-4-8",
    claudeEffort: "xhigh",
    codexModel: "gpt-5.6-sol",
    codexEffort: "medium",
    sandboxMode: "workspace-write"
  },
  researcher: {
    claudeModel: "claude-opus-4-8",
    claudeEffort: "xhigh",
    codexModel: "gpt-5.6-sol",
    codexEffort: "medium",
    sandboxMode: "read-only"
  },
  debugger: {
    claudeModel: "claude-opus-4-8",
    claudeEffort: "xhigh",
    codexModel: "gpt-5.6-sol",
    codexEffort: "medium",
    sandboxMode: "workspace-write"
  }
}

export interface ClaudeAgentDefinition {
  readonly name: AgentName
  readonly filename: string
  readonly description: string
  readonly tools: string
  readonly claudeModel: string
  readonly claudeEffort: string
  readonly instructions: string
}

export interface SyncAgentsOptions {
  readonly rootDir: string
  readonly mode: "write" | "check"
}

export class AgentSyncError extends Data.TaggedError("AgentSyncError")<{
  readonly reason: "invalid-definition" | "filesystem" | "unexpected-generated" | "stale-generated"
  readonly detail: string
  readonly cause?: unknown
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requiredString = (frontmatter: Record<string, unknown>, field: string, filename: string): string => {
  const value = frontmatter[field]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${filename}: missing ${field}`)
  }
  return value.trim()
}

const isAgentName = (value: string): value is AgentName =>
  (AGENT_NAMES as ReadonlyArray<string>).includes(value)

const quoteToml = (value: string): string => `"${value.replace(/[\\"\u0000-\u001f\u007f]/gu, (character) => {
  switch (character) {
    case "\\": return "\\\\"
    case '"': return '\\"'
    case "\b": return "\\b"
    case "\t": return "\\t"
    case "\n": return "\\n"
    case "\f": return "\\f"
    case "\r": return "\\r"
    default: return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`
  }
})}"`

export const parseClaudeAgent = (filePath: string, source: string): ClaudeAgentDefinition => {
  const filename = filePath.replaceAll("\\", "/").split("/").at(-1) ?? filePath
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source)
  if (match === null) throw new Error(`${filename}: missing YAML frontmatter`)
  const frontmatterSource = match[1]
  const bodySource = match[2]
  if (frontmatterSource === undefined || bodySource === undefined) {
    throw new Error(`${filename}: invalid frontmatter boundary`)
  }
  const parsed = parseYaml(frontmatterSource)
  if (!isRecord(parsed)) throw new Error(`${filename}: frontmatter must be a mapping`)

  const rawName = requiredString(parsed, "name", filename)
  const description = requiredString(parsed, "description", filename)
  const tools = requiredString(parsed, "tools", filename)
  const claudeModel = requiredString(parsed, "model", filename)
  const claudeEffort = requiredString(parsed, "effort", filename)
  const instructions = bodySource.trim()

  if (!isAgentName(rawName)) throw new Error(`${filename}: unexpected agent name ${rawName}`)
  if (filename !== `${rawName}.md`) throw new Error(`${filename}: filename/name mismatch for ${rawName}`)
  if (instructions === "") throw new Error(`${filename}: empty prompt body`)
  if (instructions.includes("'''")) throw new Error(`${filename}: prompt contains TOML multiline literal terminator`)
  if (instructions.endsWith("'")) {
    throw new Error(`${filename}: prompt cannot be represented safely as a TOML multiline literal because it ends with an apostrophe`)
  }

  const policy = AGENT_POLICY[rawName]
  if (claudeModel !== policy.claudeModel) {
    throw new Error(`${filename}: wrong Claude model ${claudeModel}; expected ${policy.claudeModel}`)
  }
  if (claudeEffort !== policy.claudeEffort) {
    throw new Error(`${filename}: wrong Claude effort ${claudeEffort}; expected ${policy.claudeEffort}`)
  }

  return {
    name: rawName,
    filename,
    description,
    tools,
    claudeModel,
    claudeEffort,
    instructions
  }
}

export const validateRoster = (definitions: ReadonlyArray<ClaudeAgentDefinition>): void => {
  const names = definitions.map(({ name }) => name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate !== undefined) throw new Error(`duplicate agent name: ${duplicate}`)

  const expected = [...AGENT_NAMES].sort()
  const actual = [...names].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    const missing = expected.filter((name) => !actual.includes(name))
    const unexpected = actual.filter((name) => !expected.includes(name as AgentName))
    throw new Error(`roster mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`)
  }
}

export const renderCodexAgent = (definition: ClaudeAgentDefinition): string => {
  const policy = AGENT_POLICY[definition.name]
  const instructions = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(definition.instructions)
    ? quoteToml(definition.instructions)
    : `'''${definition.instructions}'''`
  return [
    `name = ${quoteToml(definition.name)}`,
    `description = ${quoteToml(definition.description)}`,
    `model = ${quoteToml(policy.codexModel)}`,
    `model_reasoning_effort = ${quoteToml(policy.codexEffort)}`,
    `sandbox_mode = ${quoteToml(policy.sandboxMode)}`,
    `developer_instructions = ${instructions}`,
    ""
  ].join("\n")
}

const filesystemError = (operation: string, target: string, cause: unknown): AgentSyncError =>
  new AgentSyncError({ reason: "filesystem", detail: `${operation}: ${target}`, cause })

const listFiles = Effect.fn("scripts.sync-agents.listFiles")(
  function*(directory: string, extension: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const exists = yield* fs.exists(directory).pipe(
      Effect.mapError((cause) => filesystemError("exists", directory, cause))
    )
    if (!exists) return [] as ReadonlyArray<string>
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError((cause) => filesystemError("readDirectory", directory, cause))
    )
    return entries.filter((entry) => path.extname(entry) === extension).sort()
  }
)

const readDefinitions = Effect.fn("scripts.sync-agents.readDefinitions")(
  function*(claudeDir: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const filenames = yield* listFiles(claudeDir, ".md")
    const definitions = yield* Effect.forEach(filenames, (filename) =>
      fs.readFileString(path.join(claudeDir, filename)).pipe(
        Effect.mapError((cause) => filesystemError("readFileString", path.join(claudeDir, filename), cause)),
        Effect.flatMap((source) => Effect.try({
          try: () => parseClaudeAgent(filename, source),
          catch: (cause) => new AgentSyncError({
            reason: "invalid-definition",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause
          })
        }))
      ))
    yield* Effect.try({
      try: () => validateRoster(definitions),
      catch: (cause) => new AgentSyncError({
        reason: "invalid-definition",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause
      })
    })
    return definitions.sort((left, right) => AGENT_NAMES.indexOf(left.name) - AGENT_NAMES.indexOf(right.name))
  }
)

const readGenerated = Effect.fn("scripts.sync-agents.readGenerated")(
  function*(target: string) {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(target).pipe(
      Effect.mapError((cause) => filesystemError("exists", target, cause))
    )
    if (!exists) return undefined
    return yield* fs.readFileString(target).pipe(
      Effect.mapError((cause) => filesystemError("readFileString", target, cause))
    )
  }
)

export const syncAgents = Effect.fn("scripts.sync-agents.syncAgents")(
  function*({ rootDir, mode }: SyncAgentsOptions) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const claudeDir = path.join(rootDir, ".claude", "agents")
    const codexDir = path.join(rootDir, ".codex", "agents")
    const definitions = yield* readDefinitions(claudeDir)
    const expectedNames = new Set<string>(AGENT_NAMES.map((name) => `${name}.toml`))
    const actualToml = yield* listFiles(codexDir, ".toml")
    const unexpected = actualToml.filter((filename) => !expectedNames.has(filename))

    if (unexpected.length > 0) {
      return yield* new AgentSyncError({
        reason: "unexpected-generated",
        detail: `unexpected Codex agent files: ${unexpected.join(", ")}`
      })
    }

    if (mode === "check") {
      const stale: Array<string> = []
      for (const definition of definitions) {
        const filename = `${definition.name}.toml`
        const actual = yield* readGenerated(path.join(codexDir, filename))
        if (actual !== renderCodexAgent(definition)) stale.push(filename)
      }
      if (stale.length > 0) {
        return yield* new AgentSyncError({
          reason: "stale-generated",
          detail: `agent sync check failed: ${stale.sort().join(", ")}`
        })
      }
      return
    }

    yield* fs.makeDirectory(codexDir, { recursive: true }).pipe(
      Effect.mapError((cause) => filesystemError("makeDirectory", codexDir, cause))
    )
    const staged = definitions.map((definition) => {
      const target = path.join(codexDir, `${definition.name}.toml`)
      return {
        target,
        temporary: `${target}.tmp`,
        backup: `${target}.bak`,
        content: renderCodexAgent(definition),
        hadOriginal: false,
        backedUp: false,
        promoted: false
      }
    })
    const attemptAll = (operations: ReadonlyArray<Effect.Effect<void, AgentSyncError>>) =>
      Effect.gen(function*() {
        const failures: Array<Cause.Cause<AgentSyncError>> = []
        for (const operation of operations) {
          const exit = yield* Effect.exit(operation)
          if (Exit.isFailure(exit)) failures.push(exit.cause)
        }
        if (failures.length > 0) {
          let combined = failures[0] as Cause.Cause<AgentSyncError>
          for (const failure of failures.slice(1)) combined = Cause.combine(combined, failure)
          return yield* Effect.failCause(combined)
        }
      })
    const remove = (target: string) => fs.remove(target, { force: true }).pipe(
      Effect.mapError((cause) => filesystemError("remove", target, cause))
    )
    const cleanupArtifacts = () => attemptAll(staged.flatMap(({ temporary, backup }) => [
      remove(temporary),
      remove(backup)
    ]))
    const rollback = () => {
      const operations: Array<Effect.Effect<void, AgentSyncError>> = []
      for (const item of [...staged].reverse()) {
        if (item.promoted) {
          operations.push(remove(item.target).pipe(Effect.tap(() => Effect.sync(() => {
            item.promoted = false
          }))))
        }
      }
      for (const item of [...staged].reverse()) {
        if (item.backedUp) {
          operations.push(fs.rename(item.backup, item.target).pipe(
            Effect.mapError((cause) => filesystemError("rename", item.target, cause)),
            Effect.tap(() => Effect.sync(() => {
              item.backedUp = false
            }))
          ))
        }
      }
      for (const item of staged) {
        operations.push(remove(item.temporary))
        if (!item.backedUp) operations.push(remove(item.backup))
      }
      return attemptAll(operations)
    }
    let committed = false
    const transaction = Effect.gen(function*() {
      yield* Effect.forEach(staged, ({ content, temporary }) =>
        fs.writeFileString(temporary, content).pipe(
          Effect.mapError((cause) => filesystemError("writeFileString", temporary, cause))
        ), { discard: true })

      yield* Effect.forEach(staged, (item) =>
        fs.exists(item.target).pipe(
          Effect.mapError((cause) => filesystemError("exists", item.target, cause)),
          Effect.tap((exists) => Effect.sync(() => {
            item.hadOriginal = exists
          }))
        ), { discard: true })

      yield* Effect.forEach(staged, (item) => item.hadOriginal
        ? fs.rename(item.target, item.backup).pipe(
          Effect.mapError((cause) => filesystemError("rename", item.target, cause)),
          Effect.tap(() => Effect.sync(() => {
            item.backedUp = true
          })),
          Effect.uninterruptible
        )
        : Effect.void, { discard: true })

      yield* Effect.forEach(staged, (item) =>
        fs.rename(item.temporary, item.target).pipe(
          Effect.mapError((cause) => filesystemError("rename", item.target, cause)),
          Effect.tap(() => Effect.sync(() => {
            item.promoted = true
          })),
          Effect.uninterruptible
        ), { discard: true })
      committed = true
    })

    yield* transaction.pipe(Effect.onExit((transactionExit) => {
      const finalizer = Exit.isFailure(transactionExit) && !committed ? rollback() : cleanupArtifacts()
      return Effect.exit(finalizer).pipe(Effect.flatMap((cleanupExit) => {
        if (Exit.isSuccess(cleanupExit)) return Effect.void
        return Effect.failCause(Exit.isFailure(transactionExit)
          ? Cause.combine(transactionExit.cause, cleanupExit.cause)
          : cleanupExit.cause)
      }))
    }))
  }
)

const syncCommand = Command.make("sync-agents", {
  check: Flag.boolean("check")
}, ({ check }) => Effect.gen(function*() {
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  yield* syncAgents({ rootDir: root, mode: check ? "check" : "write" })
  yield* Console.log(check ? "agent definitions are synchronized" : "agent definitions synchronized")
}))

const program = Command.run(syncCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) {
  NodeRuntime.runMain(program)
}
