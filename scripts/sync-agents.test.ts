import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseToml } from "smol-toml"
import {
  AGENT_NAMES,
  AGENT_POLICY,
  parseClaudeAgent,
  renderCodexAgent,
  syncAgents,
  validateRoster,
  type AgentName,
  type ClaudeAgentDefinition
} from "./sync-agents"

const roots: string[] = []
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "expand-agent-sync-"))
  roots.push(root)
  mkdirSync(join(root, ".claude", "agents"), { recursive: true })
  return root
}

const claudeSource = (name: AgentName, body = `You are the ${name} agent.`): string => {
  const policy = AGENT_POLICY[name]
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description`,
    "tools: Read, Bash, Grep, Glob",
    `model: ${policy.claudeModel}`,
    `effort: ${policy.claudeEffort}`,
    "---",
    "",
    body,
    ""
  ].join("\n")
}

const seedRoster = (root: string): void => {
  for (const name of AGENT_NAMES) {
    writeFileSync(join(root, ".claude", "agents", `${name}.md`), claudeSource(name))
  }
}

const definition = (name: AgentName): ClaudeAgentDefinition => ({
  name,
  filename: `${name}.md`,
  description: `${name} description`,
  tools: "Read, Bash, Grep, Glob",
  claudeModel: AGENT_POLICY[name].claudeModel,
  claudeEffort: AGENT_POLICY[name].claudeEffort,
  instructions: `You are the ${name} agent.`
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("AGENT_POLICY", () => {
  it("pins the approved Claude and Codex model, effort, and sandbox map", () => {
    expect(AGENT_POLICY).toEqual({
      "code-reviewer": { claudeModel: "claude-fable-5", claudeEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "ultra", sandboxMode: "read-only" },
      "task-reviewer": { claudeModel: "claude-fable-5", claudeEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "ultra", sandboxMode: "read-only" },
      "desktop-tester": { claudeModel: "claude-opus-4-8", claudeEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "medium", sandboxMode: "workspace-write" },
      "manual-tester": { claudeModel: "claude-opus-4-8", claudeEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "medium", sandboxMode: "workspace-write" },
      "tdd-implementer": { claudeModel: "claude-opus-4-8", claudeEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "medium", sandboxMode: "workspace-write" },
      researcher: { claudeModel: "claude-opus-4-8", claudeEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "medium", sandboxMode: "read-only" },
      debugger: { claudeModel: "claude-opus-4-8", claudeEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "medium", sandboxMode: "workspace-write" }
    })
  })
})

describe("parseClaudeAgent", () => {
  it("extracts valid YAML frontmatter and the Markdown body", () => {
    const parsed = parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "Review one branch."))
    expect(parsed).toEqual({
      name: "code-reviewer",
      filename: "code-reviewer.md",
      description: "code-reviewer description",
      tools: "Read, Bash, Grep, Glob",
      claudeModel: "claude-fable-5",
      claudeEffort: "xhigh",
      instructions: "Review one branch."
    })
  })

  it.each(["name", "description", "tools", "model", "effort"])("rejects a missing %s field", (field) => {
    const source = claudeSource("code-reviewer")
      .split("\n")
      .filter((line) => !line.startsWith(`${field}:`))
      .join("\n")
    expect(() => parseClaudeAgent("code-reviewer.md", source)).toThrow(`missing ${field}`)
  })

  it("rejects an empty prompt body", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "   "))).toThrow("empty prompt body")
  })

  it("rejects a filename/name mismatch", () => {
    expect(() => parseClaudeAgent("wrong.md", claudeSource("code-reviewer"))).toThrow("filename/name mismatch")
  })

  it("rejects the TOML multiline-literal terminator", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "unsafe ''' body"))).toThrow("multiline literal terminator")
  })

  it("rejects a prompt body ending in one apostrophe", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "ends in one apostrophe'"))).toThrow("cannot be represented safely as a TOML multiline literal")
  })

  it("rejects a prompt body ending in two apostrophes", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "ends in two apostrophes''"))).toThrow("cannot be represented safely as a TOML multiline literal")
  })

  it("rejects the wrong Claude model and effort", () => {
    const wrongModel = claudeSource("code-reviewer").replace("claude-fable-5", "claude-opus-4-8")
    const wrongEffort = claudeSource("code-reviewer").replace("effort: xhigh", "effort: high")
    expect(() => parseClaudeAgent("code-reviewer.md", wrongModel)).toThrow("wrong Claude model")
    expect(() => parseClaudeAgent("code-reviewer.md", wrongEffort)).toThrow("wrong Claude effort")
  })
})

describe("validateRoster", () => {
  it("accepts exactly the seven configured agents", () => {
    expect(() => validateRoster(AGENT_NAMES.map(definition))).not.toThrow()
  })

  it("rejects duplicate, missing, and unexpected names", () => {
    const complete = AGENT_NAMES.map(definition)
    expect(() => validateRoster([...complete, definition("code-reviewer")])).toThrow("duplicate agent name")
    expect(() => validateRoster(complete.slice(1))).toThrow("roster mismatch")
    expect(() => validateRoster([
      ...complete,
      { ...definition("researcher"), name: "unexpected" as AgentName, filename: "unexpected.md" }
    ])).toThrow("roster mismatch")
  })
})

describe("renderCodexAgent", () => {
  it.each(AGENT_NAMES)("renders deterministic parseable TOML for %s", (name) => {
    const rendered = renderCodexAgent(definition(name))
    const parsed = parseToml(rendered)
    expect(renderCodexAgent(definition(name))).toBe(rendered)
    expect(rendered.endsWith("\n")).toBe(true)
    expect(parsed).toEqual({
      name,
      description: `${name} description`,
      model: AGENT_POLICY[name].codexModel,
      model_reasoning_effort: AGENT_POLICY[name].codexEffort,
      sandbox_mode: AGENT_POLICY[name].sandboxMode,
      developer_instructions: `You are the ${name} agent.`
    })
  })
})

describe("syncAgents", () => {
  it("keeps the committed Codex mirrors synchronized", async () => {
    await expect(syncAgents({ rootDir: repositoryRoot, mode: "check" })).resolves.toBeUndefined()
  })

  it("runs the synchronization gate before commits and in CI", () => {
    const hook = readFileSync(join(repositoryRoot, ".githooks", "pre-commit"), "utf8")
    const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")
    expect(hook).toContain("npm run agents:check")
    expect(workflow).toContain("run: npm run agents:check")
  })

  it("writes only expected TOML files and then passes check mode", async () => {
    const root = makeRoot()
    seedRoster(root)
    mkdirSync(join(root, ".codex", "agents"), { recursive: true })
    writeFileSync(join(root, ".codex", "agents", "README.txt"), "keep")

    await syncAgents({ rootDir: root, mode: "write" })
    writeFileSync(join(root, ".codex", "agents", "code-reviewer.toml"), "stale\n")
    await syncAgents({ rootDir: root, mode: "write" })
    await expect(syncAgents({ rootDir: root, mode: "check" })).resolves.toBeUndefined()

    for (const name of AGENT_NAMES) {
      const path = join(root, ".codex", "agents", `${name}.toml`)
      expect(existsSync(path)).toBe(true)
      expect(parseToml(readFileSync(path, "utf8"))).toMatchObject({ name })
    }
    expect(readFileSync(join(root, ".codex", "agents", "README.txt"), "utf8")).toBe("keep")
  })

  it("check mode reports modified and missing expected files", async () => {
    const root = makeRoot()
    seedRoster(root)
    await syncAgents({ rootDir: root, mode: "write" })
    writeFileSync(join(root, ".codex", "agents", "researcher.toml"), "stale\n")
    rmSync(join(root, ".codex", "agents", "debugger.toml"))
    await expect(syncAgents({ rootDir: root, mode: "check" })).rejects.toThrow(/debugger\.toml.*researcher\.toml|researcher\.toml.*debugger\.toml/)
  })

  it("reports and never deletes an unexpected TOML file", async () => {
    const root = makeRoot()
    seedRoster(root)
    mkdirSync(join(root, ".codex", "agents"), { recursive: true })
    const unexpected = join(root, ".codex", "agents", "manual-agent.toml")
    writeFileSync(unexpected, "name = \"manual-agent\"\n")
    await expect(syncAgents({ rootDir: root, mode: "write" })).rejects.toThrow("manual-agent.toml")
    await expect(syncAgents({ rootDir: root, mode: "check" })).rejects.toThrow("manual-agent.toml")
    expect(readFileSync(unexpected, "utf8")).toBe('name = "manual-agent"\n')
  })

  it("reports an unexpected canonical Markdown definition", async () => {
    const root = makeRoot()
    seedRoster(root)
    writeFileSync(join(root, ".claude", "agents", "extra.md"), claudeSource("researcher").replaceAll("researcher", "extra"))
    await expect(syncAgents({ rootDir: root, mode: "write" })).rejects.toThrow(/extra|roster mismatch/)
  })

  it("reports the canonical filename when a generated file is stale", async () => {
    const root = makeRoot()
    seedRoster(root)
    await syncAgents({ rootDir: root, mode: "write" })
    const path = join(root, ".codex", "agents", "task-reviewer.toml")
    writeFileSync(path, readFileSync(path, "utf8").replace("ultra", "medium"))
    await expect(syncAgents({ rootDir: root, mode: "check" })).rejects.toThrow(basename(path))
  })
})
