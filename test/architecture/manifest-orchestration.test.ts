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

const forbidden = [
  /&&/,
  /(?:^|\s)cd\s/,
  /(?:^|\s)(?:for|while)\s/,
  /(?:^|\s)rm\s/,
  /(?:^|\s)mkdir\s/,
  /\$\(/,
  /(?:^|\s)(?:node|tsx)\s+(?:-[^\s]+\s+)*(?:-e|--eval)\b/
] as const

const firstPartyEntries = (command: string) => command.match(/(?:^|\s)(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|sh)\b/g) ?? []

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
          for (const pattern of forbidden) {
            expect(command, `${manifestPath}#${name} contains ${String(pattern)}`).not.toMatch(pattern)
          }
          expect(firstPartyEntries(command).length, `${manifestPath}#${name} has multiple first-party entries`).toBeLessThanOrEqual(1)
          expect(command.trim().split(/\s+/)[0], `${manifestPath}#${name} is empty`).toBeTruthy()
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

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
