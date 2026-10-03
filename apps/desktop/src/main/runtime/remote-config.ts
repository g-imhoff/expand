import { Effect, FileSystem, Path, Redacted, Schema } from "effect"
import { AppContext } from "@expand/contracts/app-context"
import { BackendUnavailable } from "@expand/client-ts"

export interface SafeStorageLike {
  readonly isEncryptionAvailable: () => boolean
  readonly encryptString: (plainText: string) => Buffer
  readonly decryptString: (encrypted: Buffer) => string
}

export interface RemoteStoredConfig {
  readonly url: string
  readonly secret: string
  readonly secretProtected: boolean
}

export interface RemoteConfigInput {
  readonly url: string
  readonly token: string | Redacted.Redacted<string>
}

export const remoteConfigFile = Effect.fn("DesktopRemote.remoteConfigFile")(function*(): Effect.fn.Return<
  string,
  never,
  Path.Path | AppContext
> {
  const path = yield* Path.Path
  const { paths } = yield* AppContext
  return path.join(paths.dataDir, "remote-backend.json")
})

export const readRemoteConfig = Effect.fn("DesktopRemote.readRemoteConfig")(function*(
  file: string
): Effect.fn.Return<RemoteStoredConfig | undefined, BackendUnavailable, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(file).pipe(
    Effect.mapError((cause) => new BackendUnavailable({
      reason: `could not read stored remote backend config: ${String(cause)}`
    }))
  )
  if (!exists) return undefined
  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError(() => new BackendUnavailable({ reason: "stored remote backend config is unreadable" }))
  )
  const decoded = yield* Schema.decodeUnknownEffect(RemoteStoredConfigJson)(text).pipe(
    Effect.mapError(() => new BackendUnavailable({ reason: "stored remote backend config is invalid" }))
  )
  if (decoded.url.trim().length === 0 || decoded.secret.length === 0) {
    return yield* new BackendUnavailable({ reason: "stored remote backend config is invalid" })
  }
  return { url: decoded.url, secret: decoded.secret, secretProtected: decoded.secretProtected }
})

export const writeRemoteConfig = Effect.fn("DesktopRemote.writeRemoteConfig")(function*(
  file: string,
  input: RemoteConfigInput,
  safeStorage: SafeStorageLike | undefined
): Effect.fn.Return<void, BackendUnavailable, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const raw = typeof input.token === "string" ? input.token : Redacted.value(input.token)
  if (input.url.trim().length === 0 || raw.trim().length === 0) {
    return yield* new BackendUnavailable({ reason: "remote backend url and token are required" })
  }
  const secret = safeStorage !== undefined && safeStorage.isEncryptionAvailable()
    ? Buffer.from(safeStorage.encryptString(raw)).toString("base64")
    : raw
  const json = yield* Schema.encodeEffect(RemoteStoredConfigJson)({
    url: input.url,
    secret,
    secretProtected: safeStorage !== undefined && safeStorage.isEncryptionAvailable()
  }).pipe(
    Effect.mapError(() => new BackendUnavailable({ reason: "could not store remote backend config" }))
  )
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 }).pipe(
    Effect.mapError(() => new BackendUnavailable({ reason: "could not store remote backend config" }))
  )
  yield* fs.writeFileString(file, json, { mode: 0o600 }).pipe(
    Effect.mapError(() => new BackendUnavailable({ reason: "could not store remote backend config" }))
  )
  yield* fs.chmod(file, 0o600).pipe(
    Effect.mapError(() => new BackendUnavailable({ reason: "could not store remote backend config" }))
  )
})

export const resolveRemoteToken = (
  envToken: string | undefined,
  stored: RemoteStoredConfig | undefined,
  safeStorage: SafeStorageLike | undefined
): Effect.Effect<Redacted.Redacted<string>, BackendUnavailable> =>
  Effect.suspend(() => {
    if (envToken !== undefined && envToken.trim().length > 0) {
      return Effect.succeed(Redacted.make(envToken))
    }
    if (stored === undefined) {
      return Effect.fail(new BackendUnavailable({ reason: "remote backend token is required" }))
    }
    if (stored.secretProtected) {
      if (safeStorage === undefined || !safeStorage.isEncryptionAvailable()) {
        return Effect.fail(new BackendUnavailable({ reason: "stored remote backend token needs the OS keychain" }))
      }
      return Effect.try({
        try: () => Redacted.make(safeStorage.decryptString(Buffer.from(stored.secret, "base64"))),
        catch: () => new BackendUnavailable({ reason: "stored remote backend token is unreadable" })
      })
    }
    return Effect.succeed(Redacted.make(stored.secret))
  })

const RemoteStoredConfigJson = Schema.fromJsonString(Schema.Struct({
  url: Schema.String,
  secret: Schema.String,
  secretProtected: Schema.Boolean
}))
