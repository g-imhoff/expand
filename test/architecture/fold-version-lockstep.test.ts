import * as NodePlatform from "@effect/platform-node"
import { NodeServices } from "@effect/platform-node"
import { FOLD_VERSIONS } from "@expand/contracts/fold-version.generated"
import { it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Path } from "effect"
import * as TypeScript from "typescript"
import { describe, expect, expectTypeOf, vi } from "vitest"
import {
  computeFoldHashes,
  FoldVersionError,
  renderFoldVersions
} from "../../scripts/fold-version"

describe("FOLD_VERSIONS generation", () => {
  it.effect("matches a fresh hash of each fold's nodes", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const hashes = yield* computeFoldHashes(root)
      expect(
        FOLD_VERSIONS,
        "fold source changed — run `npm run gen:fold-version` and commit packages/contracts/fold-version.generated.ts"
      ).toEqual(hashes)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reports a missing fold node in the typed error channel", () =>
    computeFoldHashes("/repo").pipe(
      Effect.provide(FileSystem.layerNoop({
        readFileString: () => Effect.succeed("export const Different = 1\n")
      })),
      Effect.provide(Path.layer),
      Effect.provideService(Crypto.Crypto, Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, bytes) => Effect.succeed(bytes)
      })),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toMatchObject({
          _tag: "FoldVersionError",
          reason: "node-not-found",
          file: "packages/contracts/project.ts",
          node: "Project"
        })
      }))
    ))

  it("renders generated source deterministically", () => {
    const hashes = { projects: "sha256:abc" }
    const first = renderFoldVersions(hashes)
    expect(renderFoldVersions(hashes)).toBe(first)
    expect(first).toContain('"projects": "sha256:abc"')
    expect(first.endsWith("\n")).toBe(true)
  })

  it("exposes a lazy typed Effect contract", () => {
    expectTypeOf(computeFoldHashes("/repo")).toMatchTypeOf<
      Effect.Effect<Readonly<Record<string, string>>, FoldVersionError, FileSystem.FileSystem | Path.Path | Crypto.Crypto>
    >()
  })

  it.effect("performs no fold operation during a controlled dynamic import", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const runMain = vi.fn()
      const createSourceFile = vi.fn(() => {
        throw new Error("fold parsing ran during import")
      })
      vi.doMock("@effect/platform-node", () => ({
        ...NodePlatform,
        NodeRuntime: { ...NodePlatform.NodeRuntime, runMain }
      }))
      vi.doMock("typescript", () => ({ ...TypeScript, createSourceFile }))

      const module = yield* Effect.promise(() => import("../../scripts/fold-version"))

      expect(Effect.isEffect(module.computeFoldHashes("/repo"))).toBe(true)
      expect(runMain).not.toHaveBeenCalled()
      expect(createSourceFile).not.toHaveBeenCalled()
      vi.doUnmock("@effect/platform-node")
      vi.doUnmock("typescript")
      vi.resetModules()
    }))
})
