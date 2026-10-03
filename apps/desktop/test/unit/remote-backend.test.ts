import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Redacted } from "effect"
import { describe, expect } from "vitest"
import { BackendUnavailable } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import {
  makeRemoteAdapter,
  resolveRemoteRuntimeEndpoint
} from "@expand/desktop/main/runtime/remote-backend"
import {
  readRemoteConfig,
  resolveRemoteToken,
  writeRemoteConfig,
  type SafeStorageLike
} from "@expand/desktop/main/runtime/remote-config"

const token = "desktop-main-remote-secret"

const stubSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(`enc:${plainText}`),
  decryptString: (encrypted) => {
    const text = encrypted.toString()
    if (!text.startsWith("enc:")) throw new Error("bad blob")
    return text.slice(4)
  }
}

const unavailableStorage: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.from(""),
  decryptString: () => {
    throw new Error("no keychain")
  }
}

const nodeAdapter = makeNodeAdapter({ backendCommand: Effect.succeed([]) })

const withTempFile = <A, E>(use: (file: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-remote-config-" })
    return yield* use(path.join(dir, "remote-backend.json"))
  }))

describe("desktop remote backend", () => {
  it.effect("refuses local spawn through the main remote adapter", () =>
    Effect.gen(function*() {
      const adapter = makeRemoteAdapter(nodeAdapter.protocolLayer)
      const error = yield* adapter.spawnBackend("/state").pipe(Effect.flip)
      expect(error).toBeInstanceOf(BackendUnavailable)
      expect(error.reason).toBe("remote mode: local backend spawn is disabled")
    }).pipe(Effect.provide(FileSystem.layerNoop({}))))

  it.effect("stores and reads back the remote config as owner-only files", () =>
    withTempFile((file) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* writeRemoteConfig(file, { url: "ws://127.0.0.1:43111/rpc", token }, undefined)
      const stored = yield* readRemoteConfig(file)
      expect(stored).toEqual({ url: "ws://127.0.0.1:43111/rpc", secret: token, secretProtected: false })
      const mode = (yield* fs.stat(file)).mode & 0o777
      expect(mode).toBe(0o600)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("encrypts the token when a keychain is available", () =>
    withTempFile((file) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* writeRemoteConfig(file, { url: "ws://127.0.0.1:43111/rpc", token }, stubSafeStorage)
      const raw = yield* fs.readFileString(file)
      expect(raw).not.toContain(token)
      const stored = yield* readRemoteConfig(file)
      expect(stored?.secretProtected).toBe(true)
      const resolved = yield* resolveRemoteToken(undefined, stored, stubSafeStorage)
      expect(Redacted.value(resolved)).toBe(token)
      expect(String(resolved)).toBe("<redacted>")
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("prefers the environment token and fails loudly without any token", () =>
    Effect.gen(function*() {
      const stored = { url: "ws://127.0.0.1:1/rpc", secret: "stored", secretProtected: false }
      expect(Redacted.value(yield* resolveRemoteToken("env-token", stored, undefined))).toBe("env-token")
      expect(Redacted.value(yield* resolveRemoteToken("  ", stored, undefined))).toBe("stored")
      const missing = yield* resolveRemoteToken(undefined, undefined, undefined).pipe(Effect.flip)
      expect(missing).toBeInstanceOf(BackendUnavailable)
      expect(String(missing)).not.toContain(token)
      const locked = yield* resolveRemoteToken(
        undefined,
        { url: "ws://127.0.0.1:1/rpc", secret: "blob", secretProtected: true },
        unavailableStorage
      ).pipe(Effect.flip)
      expect(locked).toBeInstanceOf(BackendUnavailable)
    }))

  it.effect("rejects corrupt stored configs without leaking the token", () =>
    withTempFile((file) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(file, `{"url": "ws://127.0.0.1:1/rpc", "secret": "${token}"}`)
      const error = yield* readRemoteConfig(file).pipe(Effect.flip)
      expect(error).toBeInstanceOf(BackendUnavailable)
      expect(String(error)).not.toContain(token)
      const tampered = { url: "ws://127.0.0.1:1/rpc", secret: "not-a-blob", secretProtected: true }
      const unreadable = yield* resolveRemoteToken(undefined, tampered, stubSafeStorage).pipe(Effect.flip)
      expect(String(unreadable)).not.toContain(token)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("resolves the runtime endpoint from stored config plus environment token", () =>
    withTempFile((file) => Effect.gen(function*() {
      yield* writeRemoteConfig(file, { url: "ws://127.0.0.1:43210/rpc", token: "stored-token" }, undefined)
      const endpoint = yield* resolveRemoteRuntimeEndpoint({
        target: { host: "other.example", port: 1, token: "form-token" },
        envToken: undefined,
        configFile: file,
        safeStorage: undefined
      })
      expect(endpoint.url).toBe("ws://127.0.0.1:43210/rpc")
      expect(Redacted.value(endpoint.token)).toBe("stored-token")
      const fromForm = yield* resolveRemoteRuntimeEndpoint({
        target: { host: "127.0.0.1", port: 43211, token: "form-token" },
        envToken: undefined,
        configFile: undefined,
        safeStorage: undefined
      })
      expect(fromForm.url).toBe("ws://127.0.0.1:43211/rpc")
      expect(Redacted.value(fromForm.token)).toBe("form-token")
    })).pipe(Effect.provide(NodeServices.layer)))
})
