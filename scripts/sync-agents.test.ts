import * as NodePlatform from "@effect/platform-node"
import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Layer, Cause, Effect, Exit, FileSystem, Fiber, Path, PlatformError } from "effect"
import { describe, expect, vi } from "vitest"
import { parse as parseToml } from "smol-toml"
import { runCommand } from "../test/support/effect-process"
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

const standingClientHarness = String.raw`set -euo pipefail
ROOT="$1"
CLIENT_SCRIPT="$2"
MODE="$3"
DATA_DIR="$(mktemp -d)"
SERVER_PID=""
CLIENT_PID=""
BACKEND_PID=""
process_active() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$state" && "$(printf %.1s "$state")" != "Z" ]]
}
stop_exact() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if process_active "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..50}; do
      process_active "$pid" || break
      sleep .1
    done
  fi
  if process_active "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
    for _ in {1..50}; do
      process_active "$pid" || break
      sleep .1
    done
  fi
}
cleanup() {
  local status="$?"
  set +e
  stop_exact "$CLIENT_PID"
  stop_exact "$BACKEND_PID"
  if [[ "$SERVER_PID" != "$BACKEND_PID" ]]; then stop_exact "$SERVER_PID"; fi
  [[ -n "$CLIENT_PID" ]] && wait "$CLIENT_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null
  [[ -n "$DATA_DIR" ]] && rm -rf -- "$DATA_DIR"
  exit "$status"
}
trap cleanup EXIT
if [[ "$MODE" == "prestarted" ]]; then
  "$ROOT/dist/expand-server" --data-dir "$DATA_DIR" >"$DATA_DIR/server.log" 2>&1 &
  SERVER_PID="$!"
  for _ in {1..50}; do
    [[ -f "$DATA_DIR/server.json" ]] && break
    process_active "$SERVER_PID" || { cat "$DATA_DIR/server.log"; exit 1; }
    sleep .1
  done
  [[ -f "$DATA_DIR/server.json" ]]
fi
node --import tsx --input-type=module -e "$CLIENT_SCRIPT" "$DATA_DIR" "$ROOT/dist/expand-server" >"$DATA_DIR/client.log" 2>&1 &
CLIENT_PID="$!"
for _ in {1..50}; do
  grep -Fxq open "$DATA_DIR/client.log" && break
  process_active "$CLIENT_PID" || { cat "$DATA_DIR/client.log"; exit 1; }
  sleep .1
done
grep -Fxq open "$DATA_DIR/client.log"
BACKEND_PID="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$DATA_DIR/server.json")"
[[ "$BACKEND_PID" =~ ^[1-9][0-9]*$ ]]
if [[ "$MODE" == "prestarted" ]]; then [[ "$BACKEND_PID" == "$SERVER_PID" ]]; fi
kill -TERM "$CLIENT_PID"
for _ in {1..50}; do
  process_active "$CLIENT_PID" || break
  sleep .1
done
process_active "$CLIENT_PID" && exit 1
wait "$CLIENT_PID" 2>/dev/null || true
CLIENT_PID=""
for _ in {1..50}; do
  if ! process_active "$BACKEND_PID" && [[ ! -e "$DATA_DIR/server.json" ]]; then break; fi
  sleep .1
done
process_active "$BACKEND_PID" && exit 1
[[ ! -e "$DATA_DIR/server.json" ]]
if [[ -n "$SERVER_PID" ]]; then
  wait "$SERVER_PID"
  SERVER_PID=""
fi
BACKEND_PID=""
rm -rf -- "$DATA_DIR"
[[ ! -e "$DATA_DIR" ]]
DATA_DIR=""
printf '%s open natural-shutdown cleanup\n' "$MODE"
`

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

  it("escapes every TOML-prohibited C0 and DEL control from accepted YAML", () => {
    const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") + "\u007f"
    const yamlControls = Array.from({ length: 32 }, (_, code) => `\\u${code.toString(16).padStart(4, "0")}`).join("") + "\\u007f"
    const source = claudeSource("code-reviewer").replace(
      "description: code-reviewer description",
      `description: "before${yamlControls}after"`
    )
    const parsed = parseClaudeAgent("code-reviewer.md", source)
    expect(parsed.description).toBe(`before${controls}after`)

    const rendered = renderCodexAgent(parsed)
    expect(rendered).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u)
    expect(rendered).toContain("\\u0000")
    expect(rendered).toContain("\\b\\t\\n\\u000B\\f\\r\\u000E")
    expect(rendered).toContain("\\u007F")
    expect(parseToml(rendered).description).toBe(`before${controls}after`)

    const renderedInstructions = renderCodexAgent({ ...parsed, instructions: `before${controls}after` })
    expect(renderedInstructions).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u)
    expect(parseToml(renderedInstructions).developer_instructions).toBe(`before${controls}after`)
  })
})

describe("syncAgents", () => {
  it("returns a lazy Effect", () => {
    const program = syncAgents({ rootDir: "/repo", mode: "check" })
    expect(Effect.isEffect(program)).toBe(true)
  })

  it.effect("performs no script operation during a controlled dynamic import", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const runMain = vi.fn()
      const parse = vi.fn(() => {
        throw new Error("YAML parsing ran during import")
      })
      vi.doMock("@effect/platform-node", () => ({
        ...NodePlatform,
        NodeRuntime: { ...NodePlatform.NodeRuntime, runMain }
      }))
      vi.doMock("yaml", () => ({ parse }))

      yield* Effect.promise(() => import("./sync-agents"))

      expect(runMain).not.toHaveBeenCalled()
      expect(parse).not.toHaveBeenCalled()
      vi.doUnmock("@effect/platform-node")
      vi.doUnmock("yaml")
      vi.resetModules()
    }))

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
      Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
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
      }), Path.layer)),
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
      Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
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
      }), Path.layer)),
      Effect.flip,
      Effect.tap(() => Effect.sync(() => {
        expect(renames).toBe(0)
        expect([...files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false)
      }))
    )
  })

  it.effect("restores originals and nonexistent targets after a persistent promotion failure", () => {
    const files = new Map<string, string>()
    const directories = new Set(["/repo/.claude/agents", "/repo/.codex/agents"])
    const originals = new Map<string, string>()
    let promotions = 0
    for (const name of AGENT_NAMES) {
      files.set(`/repo/.claude/agents/${name}.md`, claudeSource(name))
      if (name !== "code-reviewer" && name !== "debugger") {
        const target = `/repo/.codex/agents/${name}.toml`
        const content = `original:${name}:\u0000bytes`
        files.set(target, content)
        originals.set(target, content)
      }
    }
    const entries = (directory: string): Array<string> => [...files.keys()]
      .filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/"))
      .map((file) => file.slice(directory.length + 1))
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: "/repo/.codex/agents/desktop-tester.toml"
    })

    return syncAgents({ rootDir: "/repo", mode: "write" }).pipe(
      Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
        exists: (target) => Effect.succeed(directories.has(target) || files.has(target)),
        readDirectory: (directory) => Effect.succeed(entries(directory)),
        readFileString: (target) => Effect.succeed(files.get(target) ?? ""),
        makeDirectory: (target) => Effect.sync(() => {
          directories.add(target)
        }),
        writeFileString: (target, content) => Effect.sync(() => {
          files.set(target, content)
        }),
        rename: (from, to) => {
          if (from.endsWith(".tmp")) {
            promotions += 1
            if (promotions === 3) return Effect.fail(failure)
          }
          return Effect.sync(() => {
            files.set(to, files.get(from) ?? "")
            files.delete(from)
          })
        },
        remove: (target) => Effect.sync(() => {
          files.delete(target)
        })
      }), Path.layer)),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toMatchObject({
          _tag: "AgentSyncError",
          reason: "filesystem",
          detail: "rename: /repo/.codex/agents/desktop-tester.toml",
          cause: failure
        })
        expect(promotions).toBe(3)
        expect(new Map([...originals.keys()].map((target) => [target, files.get(target)]))).toEqual(originals)
        expect(files.has("/repo/.codex/agents/code-reviewer.toml")).toBe(false)
        expect(files.has("/repo/.codex/agents/debugger.toml")).toBe(false)
        expect([...files.keys()].filter((file) => file.endsWith(".tmp") || file.endsWith(".bak"))).toEqual([])
      }))
    )
  })

  it.effect("retains cleanup failures without replacing the primary promotion cause", () => {
    const files = new Map<string, string>()
    const directories = new Set(["/repo/.claude/agents", "/repo/.codex/agents"])
    let promotions = 0
    for (const name of AGENT_NAMES) files.set(`/repo/.claude/agents/${name}.md`, claudeSource(name))
    const entries = (directory: string): Array<string> => [...files.keys()]
      .filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/"))
      .map((file) => file.slice(directory.length + 1))
    const promotionFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: "/repo/.codex/agents/task-reviewer.toml"
    })
    const cleanupFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "remove",
      pathOrDescriptor: "/repo/.codex/agents/code-reviewer.toml"
    })

    return Effect.gen(function*() {
      const exit = yield* Effect.exit(syncAgents({ rootDir: "/repo", mode: "write" }).pipe(
        Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
          exists: (target) => Effect.succeed(directories.has(target) || files.has(target)),
          readDirectory: (directory) => Effect.succeed(entries(directory)),
          readFileString: (target) => Effect.succeed(files.get(target) ?? ""),
          makeDirectory: (target) => Effect.sync(() => {
            directories.add(target)
          }),
          writeFileString: (target, content) => Effect.sync(() => {
            files.set(target, content)
          }),
          rename: (from, to) => {
            if (from.endsWith(".tmp")) {
              promotions += 1
              if (promotions === 2) return Effect.fail(promotionFailure)
            }
            return Effect.sync(() => {
              files.set(to, files.get(from) ?? "")
              files.delete(from)
            })
          },
          remove: (target) => target.endsWith("code-reviewer.toml") && !target.endsWith(".tmp")
            ? Effect.fail(cleanupFailure)
            : Effect.sync(() => {
              files.delete(target)
            })
        }), Path.layer))
      ))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const errors = exit.cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)
      expect(errors).toHaveLength(2)
      expect(errors[0]).toMatchObject({
        _tag: "AgentSyncError",
        detail: "rename: /repo/.codex/agents/task-reviewer.toml",
        cause: promotionFailure
      })
      expect(errors[1]).toMatchObject({
        _tag: "AgentSyncError",
        detail: "remove: /repo/.codex/agents/code-reviewer.toml",
        cause: cleanupFailure
      })
    })
  })

  it.effect("restores the transaction when interrupted after a promotion", () => {
    const files = new Map<string, string>()
    const directories = new Set(["/repo/.claude/agents", "/repo/.codex/agents"])
    const originals = new Map<string, string>()
    let promotions = 0
    for (const name of AGENT_NAMES) {
      files.set(`/repo/.claude/agents/${name}.md`, claudeSource(name))
      const target = `/repo/.codex/agents/${name}.toml`
      const content = `original:${name}`
      files.set(target, content)
      originals.set(target, content)
    }
    const entries = (directory: string): Array<string> => [...files.keys()]
      .filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/"))
      .map((file) => file.slice(directory.length + 1))

    return Effect.gen(function*() {
      const program = syncAgents({ rootDir: "/repo", mode: "write" }).pipe(
        Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
          exists: (target) => Effect.succeed(directories.has(target) || files.has(target)),
          readDirectory: (directory) => Effect.succeed(entries(directory)),
          readFileString: (target) => Effect.succeed(files.get(target) ?? ""),
          makeDirectory: (target) => Effect.sync(() => {
            directories.add(target)
          }),
          writeFileString: (target, content) => Effect.sync(() => {
            files.set(target, content)
          }),
          rename: (from, to) => {
            const move = Effect.sync(() => {
              files.set(to, files.get(from) ?? "")
              files.delete(from)
            })
            if (from.endsWith(".tmp")) {
              promotions += 1
              if (promotions === 1) return move.pipe(Effect.andThen(Effect.yieldNow))
            }
            return move
          },
          remove: (target) => Effect.sync(() => {
            files.delete(target)
          })
        }), Path.layer))
      )
      const fiber = yield* Effect.forkChild(program)
      yield* Effect.yieldNow
      expect(promotions).toBe(1)
      yield* Fiber.interrupt(fiber)
      expect(new Map([...originals.keys()].map((target) => [target, files.get(target)]))).toEqual(originals)
      expect([...files.keys()].filter((file) => file.endsWith(".tmp") || file.endsWith(".bak"))).toEqual([])
    })
  })

  it.live("executes the generated standing client against prestarted and spawned compiled backends", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
      const canonical = parseClaudeAgent(
        "manual-tester.md",
        yield* fs.readFileString(path.join(root, ".claude", "agents", "manual-tester.md"))
      )
      const generated = parseToml(
        yield* fs.readFileString(path.join(root, ".codex", "agents", "manual-tester.toml"))
      )
      expect(generated.developer_instructions).toBe(canonical.instructions)
      const command = canonical.instructions.split("\n").find((line) => line.startsWith("node --import tsx --input-type=module -e"))
      expect(command).toBeDefined()
      const prefix = "node --import tsx --input-type=module -e '"
      const suffix = "' \"$DATA_DIR\" \"$REPO_ROOT/dist/expand-server\" >\"$DATA_DIR/standing-client.log\" 2>&1 &"
      expect(command?.startsWith(prefix)).toBe(true)
      expect(command?.endsWith(suffix)).toBe(true)
      const script = command?.slice(prefix.length, -suffix.length) ?? ""
      const build = yield* runCommand("npm", ["run", "build"], { cwd: root })
      expect(build.exitCode, build.stderr).toBe(0)
      for (const mode of ["prestarted", "spawn"] as const) {
        const result = yield* runCommand("bash", ["-c", standingClientHarness, "--", root, script, mode], { cwd: root })
        expect(result.exitCode, result.stderr || result.stdout).toBe(0)
        expect(result.stdout).toContain(`${mode} open natural-shutdown cleanup`)
      }
    }).pipe(Effect.provide(NodeServices.layer))), 30_000)

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
      expect(command).toContain('import { makeNodeAdapter, ProcessServices } from "@expand/client-ts/adapters/node"')
      expect(command).toContain(`backendCommand:Effect.succeed([${processApi}argv[2]])`)
      expect(command).toContain("hold.pipe(Effect.provide(appContext), Effect.provide(ProcessServices.layer))")
      expect(command).not.toContain(`makeAppContext(${processApi}argv[1])`)
    })))
})
