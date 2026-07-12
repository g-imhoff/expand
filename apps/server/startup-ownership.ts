import { Effect } from "effect"
import type { FileSystem, Scope } from "effect"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { type AppPath, defaultDataDir } from "@expand/contracts/app-context"
import {
  type DefaultHomeMigrationError,
  migrateDefaultHome,
  type MigrateDefaultHomeOptions
} from "@expand/server/migrate-default-home"
import {
  acquireCoordinationLock,
  releaseStateRootLock,
  type StateRootLease,
  type StateRootLockError,
  stateRootLockForStartup
} from "@expand/server/state-root-lock"

export interface StartupOwnershipOptions extends MigrateDefaultHomeOptions {
  readonly beforeMigration?: Effect.Effect<void>
  readonly migrationLockFile?: string
}

export const startupOwnership = (
  paths: AppPath,
  options: StartupOwnershipOptions = {}
): Effect.Effect<
  StateRootLease,
  DefaultHomeMigrationError | StateRootLockError,
  FileSystem.FileSystem | Scope.Scope
> => {
  const normalizedDataDir = resolve(paths.dataDir)
  const normalizedDefaultDir = resolve(options.defaultDir ?? defaultDataDir())
  if (normalizedDataDir !== normalizedDefaultDir) {
    return stateRootLockForStartup(normalizedDataDir, paths.endpointFile)
  }

  const migrationLockFile = options.migrationLockFile ?? join(homedir(), ".expand-locks", "legacy-migration.lock")
  return Effect.gen(function* () {
    const guard = yield* acquireCoordinationLock(migrationLockFile)
    return yield* Effect.gen(function* () {
      yield* (options.beforeMigration ?? Effect.void)
      yield* migrateDefaultHome(normalizedDataDir, options)
      return yield* stateRootLockForStartup(normalizedDataDir, paths.endpointFile)
    }).pipe(Effect.ensuring(releaseStateRootLock(guard)))
  })
}
