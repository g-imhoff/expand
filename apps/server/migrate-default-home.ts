import { Effect } from "effect"
import type { FileSystem } from "effect"
import { defaultDataDir } from "@expand/contracts/app-context"
import { migrateLegacyHome } from "@expand/server/migrate-legacy-home"

export interface MigrateDefaultHomeOptions {
  readonly defaultDir?: string
  readonly legacyDir?: string
}

export const migrateDefaultHome = (
  dataDir: string,
  options: MigrateDefaultHomeOptions = {}
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  dataDir === (options.defaultDir ?? defaultDataDir())
    ? migrateLegacyHome(dataDir, options.legacyDir)
    : Effect.void
