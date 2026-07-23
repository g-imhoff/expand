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
  const tokens: Array<string> = []
  let token = ""
  let quote: "single" | "double" | undefined
  const finishToken = () => {
    if (token.length > 0) tokens.push(token)
    token = ""
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string
    const next = command[index + 1]
    if (character === "\n" || character === "\r") {
      violations.push("newline")
      finishToken()
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
        index += 1
      }
      continue
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single"
      continue
    }
    if (character === "\"" && quote !== "single") {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (quote === "single") {
      token += character
      continue
    }
    if ((character === "$" && next === "(") || character === "`") {
      violations.push(character === "`" ? "backtick substitution" : "command substitution")
      token += character
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
    if (character === ";" || character === "<" || character === ">") {
      violations.push(character)
      finishToken()
      continue
    }
    if (/\s/.test(character)) {
      finishToken()
      continue
    }
    token += character
  }
  finishToken()
  if (quote !== undefined) violations.push("unclosed quote")

  const forbiddenCommands = new Set(["cd", "for", "while", "rm", "mkdir"])
  if (tokens[0] !== undefined && forbiddenCommands.has(tokens[0])) violations.push("inline orchestration")
  if (tokens.some((value, index) => (value === "-e" || value === "--eval") && (tokens[0] === "node" || tokens[0] === "tsx"))) {
    violations.push("inline evaluation")
  }
  const entries = tokens.filter((value) => /(?:^|\/)[A-Za-z0-9_.-]+\.(?:ts|tsx|sh)$/.test(value))
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
      `tsx scripts/tool.ts "&& || ; | & > <" "rm" "mkdir" "cd" "for" "while"`,
      "tsx scripts/tool.ts '$(literal) `literal`'",
      String.raw`tsx scripts/tool.ts escaped\& escaped\| escaped\> escaped\< escaped\; escaped\$\(literal\) escaped\``
    ]
    for (const command of commands) expect(commandViolations(command), command).toEqual([])
  })

  it("rejects every active shell operator, substitution, newline, and multiple invocation", () => {
    const commands = [
      "tsx scripts/tool.ts && echo no",
      "tsx scripts/tool.ts || echo no",
      "tsx scripts/tool.ts ; echo no",
      "tsx scripts/tool.ts | echo no",
      "tsx scripts/tool.ts & echo no",
      "tsx scripts/tool.ts > output",
      "tsx scripts/tool.ts < input",
      "tsx scripts/tool.ts $(echo no)",
      "tsx scripts/tool.ts `echo no`",
      "tsx scripts/tool.ts\necho no",
      "tsx scripts/tool.ts \\\necho no",
      "tsx scripts/one.ts scripts/two.ts"
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
      const contracts = yield* decode("packages/contracts/package.json")
      const client = yield* decode("packages/client-ts/package.json")
      const docs = yield* decode("docs/architecture/package.json")

      expect(root.scripts).toMatchObject({
        "dev:desktop": "tsx scripts/desktop-command.ts dev",
        "build:desktop": "tsx scripts/desktop-command.ts build",
        "e2e:desktop": "tsx scripts/desktop-command.ts e2e",
        "typecheck:all": "tsc --noEmit -p tsconfig.effect-audit.json",
        "cert:cli:build": "tsx scripts/cert-cli-build.ts"
      })
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
