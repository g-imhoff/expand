import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, PlatformError } from "effect"
import { describe, expect } from "vitest"
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

const definition = (name: AgentName): ClaudeAgentDefinition => ({
  name,
  filename: `${name}.md`,
  description: `${name} description`,
  tools: "Read, Bash, Grep, Glob",
  claudeModel: AGENT_POLICY[name].claudeModel,
  claudeEffort: AGENT_POLICY[name].claudeEffort,
  instructions: `You are the ${name} agent.`
})

const withRoot = Effect.fn("scripts.sync-agents.test.withRoot")(
  function*<A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-agent-sync-" })
    yield* fs.makeDirectory(path.join(root, ".claude", "agents"), { recursive: true })
    return yield* use(root)
  }
)

const seedRoster = Effect.fn("scripts.sync-agents.test.seedRoster")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const name of AGENT_NAMES) {
      yield* fs.writeFileString(path.join(root, ".claude", "agents", `${name}.md`), claudeSource(name))
    }
  }
)

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer))

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
    expect(parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "Review one branch."))).toEqual({
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
    const source = claudeSource("code-reviewer").split("\n").filter((line) => !line.startsWith(`${field}:`)).join("\n")
    expect(() => parseClaudeAgent("code-reviewer.md", source)).toThrow(`missing ${field}`)
  })

  it("rejects malformed YAML", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", "---\n[\n---\nbody\n")).toThrow()
  })

  it("rejects an empty prompt body", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "   "))).toThrow("empty prompt body")
  })

  it("rejects a filename/name mismatch", () => {
    expect(() => parseClaudeAgent("wrong.md", claudeSource("code-reviewer"))).toThrow("filename/name mismatch")
  })

  it("rejects unsafe TOML multiline literals", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "unsafe ''' body"))).toThrow("multiline literal terminator")
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "ends in apostrophe'"))).toThrow("cannot be represented safely")
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer", "ends in apostrophes''"))).toThrow("cannot be represented safely")
  })

  it("rejects the wrong Claude model and effort", () => {
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer").replace("claude-fable-5", "claude-opus-4-8"))).toThrow("wrong Claude model")
    expect(() => parseClaudeAgent("code-reviewer.md", claudeSource("code-reviewer").replace("effort: xhigh", "effort: high"))).toThrow("wrong Claude effort")
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
    expect(() => validateRoster([...complete, { ...definition("researcher"), name: "unexpected" as AgentName, filename: "unexpected.md" }])).toThrow("roster mismatch")
  })
})

describe("renderCodexAgent", () => {
  it.each(AGENT_NAMES)("renders deterministic parseable TOML for %s", (name) => {
    const rendered = renderCodexAgent(definition(name))
    expect(renderCodexAgent(definition(name))).toBe(rendered)
    expect(rendered.endsWith("\n")).toBe(true)
    expect(parseToml(rendered)).toEqual({
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
  it("returns a lazy Effect", () => {
    const program = syncAgents({ rootDir: "/repo", mode: "check" })
    expect(Effect.isEffect(program)).toBe(true)
  })

  it.effect("keeps the committed Codex mirrors synchronized", () =>
    live(Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
      yield* syncAgents({ rootDir: root, mode: "check" })
    })))

  it.effect("runs the synchronization gate before commits and in CI", () =>
    live(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
      const hook = yield* fs.readFileString(path.join(root, ".githooks", "pre-commit"))
      const workflow = yield* fs.readFileString(path.join(root, ".github", "workflows", "ci.yml"))
      expect(hook).toContain("npm run agents:check")
      expect(workflow).toContain("run: npm run agents:check")
    })))

  it.effect("writes only expected TOML files and then passes check mode", () =>
    live(withRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* seedRoster(root)
      yield* fs.makeDirectory(path.join(root, ".codex", "agents"), { recursive: true })
      yield* fs.writeFileString(path.join(root, ".codex", "agents", "README.txt"), "keep")
      yield* syncAgents({ rootDir: root, mode: "write" })
      yield* fs.writeFileString(path.join(root, ".codex", "agents", "code-reviewer.toml"), "stale\n")
      yield* syncAgents({ rootDir: root, mode: "write" })
      yield* syncAgents({ rootDir: root, mode: "check" })
      for (const name of AGENT_NAMES) {
        const target = path.join(root, ".codex", "agents", `${name}.toml`)
        expect(yield* fs.exists(target)).toBe(true)
        expect(parseToml(yield* fs.readFileString(target))).toMatchObject({ name })
      }
      expect(yield* fs.readFileString(path.join(root, ".codex", "agents", "README.txt"))).toBe("keep")
    }))))

  it.effect("check mode reports modified and missing expected files without mutation", () =>
    live(withRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* seedRoster(root)
      yield* syncAgents({ rootDir: root, mode: "write" })
      const stale = path.join(root, ".codex", "agents", "researcher.toml")
      const missing = path.join(root, ".codex", "agents", "debugger.toml")
      yield* fs.writeFileString(stale, "stale\n")
      yield* fs.remove(missing)
      const before = yield* fs.readFileString(stale)
      const error = yield* syncAgents({ rootDir: root, mode: "check" }).pipe(Effect.flip)
      expect(error.detail).toMatch(/debugger\.toml.*researcher\.toml|researcher\.toml.*debugger\.toml/)
      expect(yield* fs.readFileString(stale)).toBe(before)
      expect(yield* fs.exists(missing)).toBe(false)
    }))))

  it.effect("reports and never deletes an unexpected TOML file", () =>
    live(withRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* seedRoster(root)
      yield* fs.makeDirectory(path.join(root, ".codex", "agents"), { recursive: true })
      const unexpected = path.join(root, ".codex", "agents", "manual-agent.toml")
      yield* fs.writeFileString(unexpected, 'name = "manual-agent"\n')
      expect((yield* syncAgents({ rootDir: root, mode: "write" }).pipe(Effect.flip)).detail).toContain("manual-agent.toml")
      expect((yield* syncAgents({ rootDir: root, mode: "check" }).pipe(Effect.flip)).detail).toContain("manual-agent.toml")
      expect(yield* fs.readFileString(unexpected)).toBe('name = "manual-agent"\n')
    }))))

  it.effect("reports an unexpected canonical Markdown definition", () =>
    live(withRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* seedRoster(root)
      yield* fs.writeFileString(path.join(root, ".claude", "agents", "extra.md"), claudeSource("researcher").replaceAll("researcher", "extra"))
      expect((yield* syncAgents({ rootDir: root, mode: "write" }).pipe(Effect.flip)).detail).toMatch(/extra|roster mismatch/)
    }))))

  it.effect("adapts YAML exceptions to the typed error channel", () =>
    live(withRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* seedRoster(root)
      yield* fs.writeFileString(path.join(root, ".claude", "agents", "code-reviewer.md"), "---\n[\n---\nbody\n")
      const error = yield* syncAgents({ rootDir: root, mode: "check" }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "AgentSyncError", reason: "invalid-definition" })
    }))))

  it.effect("stages every deterministic write before renaming", () => {
    const files = new Map<string, string>()
    const directories = new Set(["/repo/.claude/agents"])
    const operations: Array<string> = []
    for (const name of AGENT_NAMES) files.set(`/repo/.claude/agents/${name}.md`, claudeSource(name))
    const entries = (directory: string): Array<string> => [...files.keys()]
      .filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/"))
      .map((file) => file.slice(directory.length + 1))

    return syncAgents({ rootDir: "/repo", mode: "write" }).pipe(
      Effect.provide(FileSystem.layerNoop({
        exists: (target) => Effect.succeed(directories.has(target) || files.has(target)),
        readDirectory: (directory) => Effect.succeed(entries(directory)),
        readFileString: (target) => Effect.succeed(files.get(target) ?? ""),
        makeDirectory: (target) => Effect.sync(() => {
          directories.add(target)
          operations.push(`mkdir:${target}`)
        }),
        writeFileString: (target, content) => Effect.sync(() => {
          files.set(target, content)
          operations.push(`write:${target}`)
        }),
        rename: (from, to) => Effect.sync(() => {
          files.set(to, files.get(from) ?? "")
          files.delete(from)
          operations.push(`rename:${from}:${to}`)
        }),
        remove: (target) => Effect.sync(() => {
          files.delete(target)
        })
      })),
      Effect.provide(Path.layer),
      Effect.tap(() => Effect.sync(() => {
        const writes = operations.filter((operation) => operation.startsWith("write:"))
        const renames = operations.filter((operation) => operation.startsWith("rename:"))
        expect(writes).toHaveLength(AGENT_NAMES.length)
        expect(renames).toHaveLength(AGENT_NAMES.length)
        expect(operations.indexOf(renames[0] ?? "")).toBeGreaterThan(operations.indexOf(writes.at(-1) ?? ""))
        expect(writes.every((operation) => operation.endsWith(".tmp"))).toBe(true)
      }))
    )
  })

  it.effect("removes staged files and performs no rename when a write fails", () => {
    const files = new Map<string, string>()
    const directories = new Set(["/repo/.claude/agents"])
    let writes = 0
    let renames = 0
    for (const name of AGENT_NAMES) files.set(`/repo/.claude/agents/${name}.md`, claudeSource(name))
    const entries = (directory: string): Array<string> => [...files.keys()]
      .filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/"))
      .map((file) => file.slice(directory.length + 1))
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeFileString",
      pathOrDescriptor: "/repo/.codex/agents/desktop-tester.toml.tmp"
    })

    return syncAgents({ rootDir: "/repo", mode: "write" }).pipe(
      Effect.provide(FileSystem.layerNoop({
        exists: (target) => Effect.succeed(directories.has(target) || files.has(target)),
        readDirectory: (directory) => Effect.succeed(entries(directory)),
        readFileString: (target) => Effect.succeed(files.get(target) ?? ""),
        makeDirectory: (target) => Effect.sync(() => {
          directories.add(target)
        }),
        writeFileString: (target, content) => {
          writes += 1
          if (writes === 3) return Effect.fail(failure)
          return Effect.sync(() => {
            files.set(target, content)
          })
        },
        rename: () => Effect.sync(() => {
          renames += 1
        }),
        remove: (target) => Effect.sync(() => {
          files.delete(target)
        })
      })),
      Effect.provide(Path.layer),
      Effect.flip,
      Effect.tap(() => Effect.sync(() => {
        expect(renames).toBe(0)
        expect([...files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false)
      }))
    )
  })

  it.effect("builds the manual standing-client AppContext from explicit host inputs", () =>
    live(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
      const source = yield* fs.readFileString(path.join(root, ".claude", "agents", "manual-tester.md"))
      const command = source.split("\n").find((line) => line.startsWith("node --import tsx --input-type=module -e"))
      const nodeOs = ["node:", "os"].join("")
      const processApi = "process."
      expect(command).toBeDefined()
      expect(command).toContain('import { Effect, Layer, Path } from "effect"')
      expect(command).toContain(`import { homedir } from "${nodeOs}"`)
      expect(command).toContain("const path=yield* Path.Path")
      expect(command).toContain(`AppContext.make(path,{homeDir:homedir(),cwd:${processApi}cwd(),dataDir:${processApi}argv[1]})`)
      expect(command).toContain("hold.pipe(Effect.provide(appContext), Effect.provide(NodeServices.layer))")
      expect(command).not.toContain(`makeAppContext(${processApi}argv[1])`)
    })))
})
