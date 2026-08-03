import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { ENVELOPE_VERSION } from "../../apps/cli/cli/contract/envelope"
import {
  EVENT_REVISIONS,
  EVENT_UPCASTERS,
  type EventUpcasterRegistry
} from "../../apps/server/migrations/events"
import { CURRENT_DATABASE_MIGRATION, DATABASE_MIGRATIONS } from "../../apps/server/migrations/sqlite"
import { PROTOCOL_VERSION } from "../../packages/contracts/rpc/version"
import { BUILD_ENTRIES } from "../../scripts/build"
import { resolveAppVersionObservation } from "../../scripts/app-version"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"

const manifestPaths = [
  "package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
  "packages/client-ts/package.json",
  "docs/architecture/package.json"
] as const

const documentedDomains = [
  "Product release",
  "Tracked workspace manifests",
  "CLI envelope",
  "Backend protocol",
  "SQLite schema",
  "Stored events",
  "Projection folds",
  "Audit inventories",
  "Benchmark seed cache",
  "Internal Effect commands",
  "Runtime and dependency pins",
  "Codex review model"
] as const

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  private: Schema.optional(Schema.Boolean),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const walkTypeScript = Effect.fn("VersionPolicy.walkTypeScript")(function*(
  directory: string
): Effect.fn.Return<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files: Array<string> = []
  for (const entry of yield* fs.readDirectory(directory)) {
    if (["node_modules", "dist", "dist-publish", "out", "test", "test-results"].includes(entry)) continue
    const child = path.join(directory, entry)
    const info = yield* fs.stat(child)
    if (info.type === "Directory") files.push(...yield* walkTypeScript(child))
    else if (/\.(?:ts|tsx)$/.test(entry) && !/\.(?:test|generated)\.(?:ts|tsx)$/.test(entry)) files.push(child)
  }
  return files
})

const atRepositoryRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
    return yield* use(root)
  }).pipe(Effect.provide(NodeServices.layer))

describe("version policy", () => {
  it.live("keeps compatibility literals under one approved owner", () =>
    atRepositoryRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(ENVELOPE_VERSION).toBe("expand/v1")
      expect(PROTOCOL_VERSION).toBe(2)
      expect(EVENT_REVISIONS.ProjectCreated).toBe(2)
      expect(CURRENT_DATABASE_MIGRATION).toBe(1)

      const definitions = {
        ENVELOPE_VERSION: [] as Array<string>,
        PROTOCOL_VERSION: [] as Array<string>
      }
      for (const relative of [...yield* walkTypeScript(path.join(root, "apps")), ...yield* walkTypeScript(path.join(root, "packages"))]) {
        const source = yield* fs.readFileString(relative)
        for (const name of Object.keys(definitions) as Array<keyof typeof definitions>) {
          if (new RegExp(`\\bexport\\s+const\\s+${name}\\b`).test(source)) {
            definitions[name].push(path.relative(root, relative))
          }
        }
      }

      expect(definitions.ENVELOPE_VERSION).toEqual(["apps/cli/cli/contract/envelope.ts"])
      expect(definitions.PROTOCOL_VERSION).toEqual(["packages/contracts/rpc/version.ts"])
    })))

  it.effect("keeps migration chains contiguous and release observations deterministic", () =>
    Effect.gen(function*() {
      const upcasters: EventUpcasterRegistry = EVENT_UPCASTERS
      for (const [tag, currentRevision] of Object.entries(EVENT_REVISIONS)) {
        for (let revision = 1; revision < currentRevision; revision += 1) {
          expect(upcasters[tag]?.[revision], `${tag} revision ${revision}`).toBeTypeOf("function")
        }
      }

      const migrationIds = Object.keys(DATABASE_MIGRATIONS).map((key) => {
        expect(key).toMatch(/^\d+_/)
        return Number.parseInt(key, 10)
      })
      expect(new Set(migrationIds).size).toBe(migrationIds.length)
      expect(migrationIds).toEqual([...migrationIds].sort((left, right) => left - right))
      expect(migrationIds.at(-1)).toBe(CURRENT_DATABASE_MIGRATION)

      expect(yield* resolveAppVersionObservation({ exactTags: ["v1.2.3"], shortSha: undefined }, "release")).toBe("1.2.3")
      expect(yield* resolveAppVersionObservation({ exactTags: [], shortSha: "0123456789ab" }, "development")).toBe("0.0.0-dev+0123456789ab")
      const malformed = yield* resolveAppVersionObservation({ exactTags: ["v01.2.3"], shortSha: undefined }, "release").pipe(Effect.flip)
      expect(malformed.reason).toBe("invalid-release-tag")
      const conflicting = yield* resolveAppVersionObservation({ exactTags: ["v1.2.3", "v2.0.0"], shortSha: undefined }, "release").pipe(Effect.flip)
      expect(conflicting.reason).toBe("conflicting-release-tags")
    }))

  it.live("keeps one artifact identity flowing through build and staging", () =>
    atRepositoryRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const read = (relative: string) => fs.readFileString(path.join(root, relative))
      const build = yield* read("scripts/build.ts")
      const desktopCommand = yield* read("scripts/desktop-command.ts")
      const desktopConfig = yield* read("apps/desktop/electron.vite.config.ts")
      const contractsStage = yield* read("packages/contracts/scripts/prepare-publish.ts")
      const clientStage = yield* read("packages/client-ts/scripts/prepare-publish.ts")
      const buildInfo = yield* read("packages/contracts/build-info.ts")

      expect(BUILD_ENTRIES).toHaveLength(2)
      const buildBinaries = build.slice(build.indexOf("export const buildBinaries"), build.indexOf("const buildTool"))
      expect(buildBinaries).toMatch(/function\*\s*\(rootDir:\s*string,\s*appVersion:\s*string\)/)
      expect(buildBinaries).toMatch(/buildOptions\(rootDir,\s*path\.join\(rootDir,\s*entry\),\s*outfile,\s*appVersion\)/)
      expect(buildBinaries).not.toMatch(/resolve(?:Build)?AppVersion/)
      expect(build).toMatch(/define:\s*\{[^}]*__EXPAND_VERSION__:\s*`"\$\{appVersion\}"`/)
      expect(desktopCommand).toMatch(/function\*\s*\(root:\s*string,\s*mode:\s*DesktopMode,\s*appVersion:\s*string\)/)
      expect(desktopCommand).toMatch(/EXPAND_APP_VERSION:\s*appVersion/)
      expect(desktopConfig.match(/__EXPAND_VERSION__/g)).toHaveLength(3)
      expect(buildInfo).toMatch(/__EXPAND_VERSION__/)

      for (const source of [contractsStage, clientStage]) {
        expect(source).toMatch(/version:\s*releaseVersion/)
        expect(source).not.toMatch(/version:\s*source\.version/)
      }
      expect(clientStage).toMatch(/"@expand\/contracts":\s*releaseVersion/)

      const forbidden = /\bgit (?:describe|tag|rev-parse)\b|node:child_process|child_process/
      for (const relative of [...yield* walkTypeScript(path.join(root, "apps")), ...yield* walkTypeScript(path.join(root, "packages"))]) {
        expect(yield* fs.readFileString(relative), path.relative(root, relative)).not.toMatch(forbidden)
      }
    })))

  it.live("keeps tracked manifests as sentinels and documents every version domain", () =>
    atRepositoryRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifests = new Map<string, typeof Manifest.Type>()
      for (const relative of manifestPaths) {
        const manifest = yield* fs.readFileString(path.join(root, relative)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest)))
        )
        manifests.set(relative, manifest)
        if (manifest.private === true && manifest.version !== undefined) {
          expect(manifest.version, relative).toBe("0.0.0")
        }
      }

      const contracts = manifests.get("packages/contracts/package.json")
      const client = manifests.get("packages/client-ts/package.json")
      expect(contracts?.version).toBe("0.0.0")
      expect(client?.version).toBe("0.0.0")
      expect(client?.dependencies?.["@expand/contracts"]).toBe(contracts?.version)

      const documentation = yield* fs.readFileString(path.join(root, "docs/architecture/VERSIONING.md"))
      for (const domain of documentedDomains) {
        const occurrences = documentation.split("\n").filter((line) => line === `## ${domain}`).length
        expect(occurrences, domain).toBe(1)
      }
      expect(documentation).toContain("v<SemVer>")
      expect(documentation).toContain("expand/v1")
      expect(documentation).toContain("gpt-5.6-luna")
      expect(documentation).toContain("max")
    })))
})
