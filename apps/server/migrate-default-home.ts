import { Data, Effect, FileSystem } from "effect"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { defaultDataDir } from "@expand/contracts/app-context"
import { migrateLegacyHome } from "@expand/server/migrate-legacy-home"

export interface MigrateDefaultHomeOptions {
  readonly defaultDir?: string
  readonly legacyDir?: string
}

export class DefaultHomeMigrationError extends Data.TaggedError("DefaultHomeMigrationError")<{
  readonly dataDir: string
  readonly recoverablePath: string
  readonly reason: string
}> {}

export const migrateDefaultHome = (
  dataDir: string,
  options: MigrateDefaultHomeOptions = {}
): Effect.Effect<void, DefaultHomeMigrationError, FileSystem.FileSystem> => {
  const normalizedTarget = resolve(dataDir)
  if (normalizedTarget !== resolve(options.defaultDir ?? defaultDataDir())) return Effect.void
  const normalizedLegacy = resolve(options.legacyDir ?? join(homedir(), ".expand"))
  const stage = `${normalizedLegacy}.migrating-${basename(normalizedTarget)}`
  const legacyDatabase = join(normalizedLegacy, "events.db")

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* migrateLegacyHome(normalizedTarget, normalizedLegacy)
    if (yield* fs.exists(stage).pipe(Effect.orElseSucceed(() => false))) {
      return yield* Effect.fail(new DefaultHomeMigrationError({
        dataDir: normalizedTarget,
        recoverablePath: stage,
        reason: `default-home migration left recoverable data at ${stage}`
      }))
    }
    if (yield* fs.exists(legacyDatabase).pipe(Effect.orElseSucceed(() => false))) {
      return yield* Effect.fail(new DefaultHomeMigrationError({
        dataDir: normalizedTarget,
        recoverablePath: legacyDatabase,
        reason: `default-home migration left the legacy database at ${legacyDatabase}`
      }))
    }
  })
}
