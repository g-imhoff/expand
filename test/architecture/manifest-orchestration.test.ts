import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"

const Manifest = Schema.Struct({
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const DocsPackage = Schema.Struct({
  overrides: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String)
})

const LockPackage = Schema.Struct({ version: Schema.String })
const DocsLock = Schema.Struct({
  packages: Schema.Record(Schema.String, Schema.Unknown)
})

const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
  "packages/client-ts/package.json",
  "docs/architecture/package.json"
] as const

const commandViolations = (command: string): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const tokens: Array<{ readonly value: string; readonly active: boolean }> = []
  let token = ""
  let tokenHasUnquoted = false
  let quote: "single" | "double" | undefined
  const finishToken = () => {
    if (token.length > 0) tokens.push({ value: token, active: tokenHasUnquoted })
    token = ""
    tokenHasUnquoted = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string
    const next = command[index + 1]
    if (character === "\n" || character === "\r") {
      violations.push("newline")
      finishToken()
      continue
    }
    if (quote === "single") {
      if (character === "'") quote = undefined
      else token += character
      continue
    }
    if (character === "\\") {
      if (next === undefined) {
        violations.push("trailing escape")
      } else if (next === "\n" || next === "\r") {
        violations.push("newline")
        index += 1
        finishToken()
      } else {
        token += next
        tokenHasUnquoted = tokenHasUnquoted || quote === undefined
        index += 1
      }
      continue
    }
    if (character === "'" && quote === undefined) {
      quote = "single"
      continue
    }
    if (character === "\"") {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (character === "`") {
      violations.push("backtick substitution")
      token += character
      tokenHasUnquoted = tokenHasUnquoted || quote === undefined
      continue
    }
    if (character === "$" && next !== undefined && /[({A-Za-z_0-9@*#?$!-]/.test(next)) {
      violations.push("shell expansion")
      token += character
      tokenHasUnquoted = tokenHasUnquoted || quote === undefined
      continue
    }
    if (quote === "double") {
      token += character
      continue
    }
    if (character === "&" || character === "|") {
      const operator = next === character ? `${character}${character}` : character
      violations.push(operator)
      if (next === character) index += 1
      finishToken()
      continue
    }
    if (character === ";" || character === "<" || character === ">" || character === "(" || character === ")" || character === "!") {
      violations.push(character)
      finishToken()
      continue
    }
    if (/\s/.test(character)) {
      finishToken()
      continue
    }
    token += character
    tokenHasUnquoted = true
  }
  finishToken()
  if (quote !== undefined) violations.push("unclosed quote")

  const values = tokens.map((token) => token.value)
  const activeTokens = tokens.filter((token) => token.active).map((token) => token.value)
  const executableName = (value: string) => value.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, "") ?? value
  const forbiddenTokens = new Set(["cd", "for", "while", "do", "done", "rm", "mkdir"])
  const wrappers = new Set(["sh", "bash", "dash", "zsh", "cmd", "powershell", "pwsh", "eval", "env", "command", "exec"])
  if (activeTokens.some((value) => forbiddenTokens.has(value))) violations.push("inline orchestration")
  if (
    (values[0] !== undefined && wrappers.has(executableName(values[0]))) ||
    activeTokens.some((value) => wrappers.has(executableName(value)))
  ) violations.push("wrapper invocation")
  const evaluators = new Set(["node", "tsx", "bun", "npm", "npx", "pnpm", "yarn"])
  const hasEvaluator = values.some((value, index) => evaluators.has(executableName(value)) && (index === 0 || tokens[index]?.active))
  const hasEvalFlag = values.some((value) => /^(?:-e|--eval|-p|--print)(?:=|$)/.test(value))
  if (hasEvaluator && hasEvalFlag) violations.push("inline evaluation")
  const entries = tokens.map((token) => token.value).filter((value) => /(?:^|\/)[A-Za-z0-9_.-]+\.(?:ts|tsx|sh)$/.test(value))
  if (entries.length > 1) violations.push("multiple first-party entries")
  return violations
}

describe("manifest orchestration", () => {
  it.live("keeps every manifest script to one entry with no inline orchestration", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const manifestPath of manifests) {
        const manifest = yield* fs.readFileString(path.resolve(manifestPath)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest)))
        )
        for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
          expect(commandViolations(command), `${manifestPath}#${name}`).toEqual([])
          expect(command.trim().split(/\s+/)[0], `${manifestPath}#${name} is empty`).toBeTruthy()
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it("allows shell operators only as quoted or escaped literal arguments", () => {
    const commands = [
      `tsx scripts/tool.ts "() ! && || ; | & > <" "rm" "mkdir" "cd" "for" "while"`,
      "tsx scripts/tool.ts '$(literal) ${literal} $literal `literal` bash -c env exec'",
      String.raw`tsx scripts/tool.ts escaped\( escaped\) escaped\! escaped\& escaped\| escaped\> escaped\< escaped\; escaped\$\(literal\) escaped\` escaped\$literal`
    ]
    for (const command of commands) expect(commandViolations(command), command).toEqual([])
  })

  it("rejects every active shell operator, substitution, newline, and multiple invocation", () => {
    const commands = [
      "tsx scripts/tool.ts ( echo no )",
      "! tsx scripts/tool.ts",
      "tsx scripts/tool.ts && echo no",
      "tsx scripts/tool.ts || echo no",
      "tsx scripts/tool.ts ; echo no",
      "tsx scripts/tool.ts | echo no",
      "tsx scripts/tool.ts & echo no",
      "tsx scripts/tool.ts > output",
      "tsx scripts/tool.ts < input",
      "tsx scripts/tool.ts $(echo no)",
      "tsx scripts/tool.ts `echo no`",
      "tsx scripts/tool.ts $HOME",
      "tsx scripts/tool.ts ${HOME}",
      "tsx scripts/tool.ts \"$HOME\"",
      "tsx scripts/tool.ts\necho no",
      "tsx scripts/tool.ts \\\necho no",
      "tsx scripts/one.ts scripts/two.ts"
    ]
    for (const command of commands) expect(commandViolations(command), command).not.toEqual([])
  })

  it("rejects shell, evaluator, environment, execution, and package-manager wrappers", () => {
    const commands = [
      "bash -c 'tsx scripts/tool.ts'",
      "'/bin/bash' -c 'tsx scripts/tool.ts'",
      "sh -c 'echo harmless'",
      "dash -c 'echo harmless'",
      "zsh -c 'echo harmless'",
      "cmd /c 'echo harmless'",
      "cmd.exe /c 'echo harmless'",
      "powershell -Command 'Write-Output harmless'",
      "eval 'echo harmless'",
      "env X=1 rm -rf output",
      "command tsx scripts/tool.ts",
      "exec tsx scripts/tool.ts",
      "tsx scripts/tool.ts rm output",
      "node -e 'harmless'",
      "node '--eval' 'harmless'",
      "npm exec -- node -e 'harmless'",
      "npx node --eval 'harmless'",
      "npx node '-p' '1'",
      "pnpm exec node -e 'harmless'",
      "yarn node -e 'harmless'",
      "bun -e 'harmless'"
    ]
    for (const command of commands) expect(commandViolations(command), command).not.toEqual([])
  })

  it.live("routes package, desktop, docs, certification, and aggregate typecheck workflows through direct entries", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const decode = (file: string) => fs.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest)))
      )
      const root = yield* decode("package.json")
      const desktop = yield* decode("apps/desktop/package.json")
      const contracts = yield* decode("packages/contracts/package.json")
      const client = yield* decode("packages/client-ts/package.json")
      const docs = yield* decode("docs/architecture/package.json")

      const { "effect:grep": effectGrep, ...rootScripts } = root.scripts ?? {}
      expect(effectGrep).toBeTypeOf("string")
      expect(commandViolations(effectGrep ?? "")).toEqual([])
      expect(rootScripts).toEqual({
        "effect:diagnostics": "effect-language-service diagnostics --project tsconfig.effect-audit.json --format json --severity error,message",
        "effect:audit": "tsx scripts/effect-audit.ts",
        "effect:audit:update": "tsx scripts/effect-audit.ts --update",
        "effect:diagnostics:root": "effect-language-service diagnostics --project tsconfig.json --format json --severity error,message",
        "effect:diagnostics:desktop": "effect-language-service diagnostics --project apps/desktop/tsconfig.json --format json --severity error,message",
        "typecheck:effect-audit": "tsc --noEmit -p tsconfig.effect-audit.json",
        typecheck: "tsc --noEmit",
        "gen:fold-version": "tsx scripts/fold-version.ts",
        "agents:sync": "tsx scripts/sync-agents.ts",
        "agents:check": "tsx scripts/sync-agents.ts --check",
        "bench:events": "node --expose-gc --import tsx bench/main.ts",
        "bench:selfcheck": "node --expose-gc --import tsx bench/selfcheck.ts",
        "typecheck:all": "tsc --noEmit -p tsconfig.effect-audit.json",
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        "test:watch": "vitest",
        arch: "depcruise apps packages --config .dependency-cruiser.cjs",
        knip: "knip",
        build: "tsx scripts/build.ts",
        "cert:cli:build": "tsx scripts/cert-cli-build.ts",
        "dev:cli": "tsx apps/cli/cli/main.ts",
        "dev:server": "tsx apps/server/main.ts",
        "dev:tui": "tsx apps/tui/main.tsx",
        "dev:desktop": "tsx scripts/desktop-command.ts dev",
        "build:desktop": "tsx scripts/desktop-command.ts build",
        "typecheck:desktop": "tsc --noEmit -p apps/desktop/tsconfig.json",
        "e2e:desktop": "tsx scripts/desktop-command.ts e2e",
        lint: "eslint .",
        prepare: "git config core.hooksPath .githooks",
        doctor: "npx react-doctor@latest"
      })
      expect(desktop.scripts).toBeUndefined()
      expect(contracts.scripts).toEqual({
        build: "tsx scripts/prepare-publish.ts build",
        "stage:publish": "tsx scripts/prepare-publish.ts stage",
        "pack:tgz": "tsx scripts/prepare-publish.ts pack"
      })
      expect(client.scripts).toEqual({
        build: "tsx scripts/prepare-publish.ts build",
        "stage:publish": "tsx scripts/prepare-publish.ts stage",
        "pack:tgz": "tsx scripts/prepare-publish.ts pack"
      })
      expect(docs.scripts).toEqual({
        dev: "likec4 start",
        build: "tsx scripts/build.ts"
      })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps the architecture toolchain isolated at exact versions", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const docs = yield* fs.readFileString("docs/architecture/package.json").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DocsPackage)))
      )
      expect(docs.devDependencies).toEqual({
        "@effect/platform-node": "4.0.0-beta.74",
        "@effect/vitest": "4.0.0-beta.74",
        effect: "4.0.0-beta.74",
        likec4: "1.56.0",
        tsx: "4.21.0",
        typescript: "6.0.3",
        vitest: "4.1.7"
      })
      expect(docs.overrides).toEqual({ "@effect/platform-node-shared": "4.0.0-beta.74" })

      const lock = yield* fs.readFileString("docs/architecture/package-lock.json").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DocsLock)))
      )
      const expected = {
        "node_modules/@effect/platform-node": "4.0.0-beta.74",
        "node_modules/@effect/platform-node-shared": "4.0.0-beta.74",
        "node_modules/@effect/vitest": "4.0.0-beta.74",
        "node_modules/effect": "4.0.0-beta.74",
        "node_modules/tsx": "4.21.0",
        "node_modules/typescript": "6.0.3",
        "node_modules/vitest": "4.1.7"
      }
      for (const [path, version] of Object.entries(expected)) {
        const entry = yield* Schema.decodeUnknownEffect(LockPackage)(lock.packages[path])
        expect(entry.version, path).toBe(version)
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
