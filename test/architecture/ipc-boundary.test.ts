import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

const read = Effect.fn("IpcBoundary.read")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file)
})

const walk = Effect.fn("IpcBoundary.walk")(function*(dir: string): Effect.fn.Return<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(dir)
  const files: Array<string> = []
  for (const entry of entries) {
    const full = path.join(dir, entry)
    if (entry === "node_modules" || entry === "out" || entry === "dist" || entry === "test-results") continue
    const info = yield* fs.stat(full)
    if (info.type === "Directory") files.push(...yield* walk(full))
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full)
  }
  return files
})

describe("typed IPC boundary", () => {
  it.live("contract, internals, and renderer never import electron", () =>
    Effect.gen(function*() {
      for (const file of ["contract.ts", "internal/contract.ts", "internal/wire.ts", "renderer.ts"]) {
        const source = yield* read(`packages/electron-ipc/${file}`)
        expect(source, `${file} must stay electron-free`).not.toMatch(/from\s+"electron"/)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("only the electron adapters touch ipcMain/ipcRenderer/contextBridge", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const allowed = new Set([
        path.join("packages/electron-ipc", "preload.ts"),
        path.join("packages/electron-ipc", "main.ts")
      ])
      const files = [...yield* walk("apps/desktop/src"), ...yield* walk("packages")]
      for (const file of files) {
        if (allowed.has(file) || file.includes("/test/")) continue
        const source = yield* read(file)
        expect(source, `${file} must not use raw Electron IPC primitives`).not.toMatch(
          /\b(ipcMain|ipcRenderer|contextBridge)\b/
        )
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("the preload imports only electron-ipc modules and the registry", () =>
    read("apps/desktop/src/preload/index.ts").pipe(
      Effect.tap((source) => Effect.sync(() => {
        const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
        for (const specifier of imports) {
          expect(
            specifier === "@expand/desktop/shared/ipc/channels" || specifier!.startsWith("@expand/electron-ipc/"),
            `preload imports forbidden module: ${specifier}`
          ).toBe(true)
        }
      })),
      Effect.provide(NodeServices.layer)
    ))

  it.live("no legacy magic channel strings survive outside the framework", () =>
    Effect.gen(function*() {
      for (const file of yield* walk("apps/desktop/src")) {
        const source = yield* read(file)
        expect(source, `${file} contains a legacy channel literal`).not.toMatch(/"expand:port-request"|"expand:port"/)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("dependency-cruiser IPC rules hold", () =>
    runCommand("npm", ["exec", "--", "depcruise", "apps", "packages", "--config", ".dependency-cruiser.cjs"]).pipe(
      Effect.tap((report) => Effect.sync(() => {
        const output = `${report.stdout}${report.stderr}`
        expect(output).not.toContain("electron-ipc-package-isolated")
        expect(output).not.toContain("shared-ipc-stays-pure")
        expect(output).not.toContain("preload-imports-allowlist")
        expect(report.exitCode).toBe(0)
      })),
      Effect.provide(NodeServices.layer)
    ))
})
