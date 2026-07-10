import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"

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

export const parseClaudeAgent = (filePath: string, source: string): ClaudeAgentDefinition => {
  const filename = basename(filePath)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source)
  if (match === null) throw new Error(`${filename}: missing YAML frontmatter`)
  const frontmatterSource = match[1]
  const bodySource = match[2]
  if (frontmatterSource === undefined || bodySource === undefined) {
    throw new Error(`${filename}: invalid frontmatter boundary`)
  }
  const parsed = Bun.YAML.parse(frontmatterSource)
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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !actual.includes(name))
    const unexpected = actual.filter((name) => !expected.includes(name as AgentName))
    throw new Error(`roster mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`)
  }
}

export const renderCodexAgent = (definition: ClaudeAgentDefinition): string => {
  const policy = AGENT_POLICY[definition.name]
  return [
    `name = ${JSON.stringify(definition.name)}`,
    `description = ${JSON.stringify(definition.description)}`,
    `model = ${JSON.stringify(policy.codexModel)}`,
    `model_reasoning_effort = ${JSON.stringify(policy.codexEffort)}`,
    `sandbox_mode = ${JSON.stringify(policy.sandboxMode)}`,
    `developer_instructions = '''${definition.instructions}'''`,
    ""
  ].join("\n")
}

const listFiles = async (dir: string, extension: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name) === extension)
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return []
    throw error
  }
}

const readDefinitions = async (claudeDir: string): Promise<ReadonlyArray<ClaudeAgentDefinition>> => {
  const filenames = await listFiles(claudeDir, ".md")
  const definitions = await Promise.all(
    filenames.map(async (filename) => parseClaudeAgent(filename, await readFile(join(claudeDir, filename), "utf8")))
  )
  validateRoster(definitions)
  return definitions.sort((left, right) => AGENT_NAMES.indexOf(left.name) - AGENT_NAMES.indexOf(right.name))
}

const readGenerated = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

export const syncAgents = async ({ rootDir, mode }: SyncAgentsOptions): Promise<void> => {
  const claudeDir = join(rootDir, ".claude", "agents")
  const codexDir = join(rootDir, ".codex", "agents")
  const definitions = await readDefinitions(claudeDir)
  const expectedNames = new Set<string>(AGENT_NAMES.map((name) => `${name}.toml`))
  const actualToml = await listFiles(codexDir, ".toml")
  const unexpected = actualToml.filter((filename) => !expectedNames.has(filename))

  if (unexpected.length > 0) {
    throw new Error(`unexpected Codex agent files: ${unexpected.join(", ")}`)
  }

  if (mode === "check") {
    const stale: string[] = []
    for (const definition of definitions) {
      const filename = `${definition.name}.toml`
      const actual = await readGenerated(join(codexDir, filename))
      if (actual !== renderCodexAgent(definition)) stale.push(filename)
    }
    if (stale.length > 0) throw new Error(`agent sync check failed: ${stale.sort().join(", ")}`)
    return
  }

  await mkdir(codexDir, { recursive: true })
  for (const definition of definitions) {
    const target = join(codexDir, `${definition.name}.toml`)
    const temporary = `${target}.tmp`
    await writeFile(temporary, renderCodexAgent(definition))
    await rename(temporary, target)
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  if (args.some((arg) => arg !== "--check") || args.filter((arg) => arg === "--check").length > 1) {
    console.error("usage: bun run scripts/sync-agents.ts [--check]")
    process.exit(2)
  }
  const mode = args[0] === "--check" ? "check" : "write"
  try {
    await syncAgents({ rootDir: resolve(import.meta.dir, ".."), mode })
    console.log(mode === "check" ? "agent definitions are synchronized" : "agent definitions synchronized")
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
