import { Effect, FileSystem } from "effect"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// One-time relocation of a pre-existing flat `~/.expand` into the new OS-correct
// data dir on first run, so existing dev projects survive. Best-effort: logs a
// warning and leaves the legacy dir in place if the move fails.
export const migrateLegacyHome = (
  dataDir: string,
  legacyDir: string = join(homedir(), ".expand")
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (legacyDir === dataDir) return
    const legacyExists = yield* fs.exists(legacyDir).pipe(Effect.orElseSucceed(() => false))
    const targetExists = yield* fs.exists(dataDir).pipe(Effect.orElseSucceed(() => false))
    if (!legacyExists || targetExists) return
    yield* fs.makeDirectory(dirname(dataDir), { recursive: true }).pipe(Effect.ignore)
    yield* fs.rename(legacyDir, dataDir).pipe(
      Effect.catch(() =>
        Effect.logWarning(`could not migrate ${legacyDir} -> ${dataDir}; move it manually`)
      )
    )
  })
