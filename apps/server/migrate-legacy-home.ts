import { Effect, FileSystem } from "effect"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const migrateLegacyHome = (
  dataDir: string,
  legacyDir: string = join(homedir(), ".expand")
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const normalizedLegacy = resolve(legacyDir)
    const normalizedTarget = resolve(dataDir)
    if (normalizedLegacy === normalizedTarget) return
    const targetExists = yield* fs.exists(dataDir).pipe(Effect.orElseSucceed(() => false))
    if (targetExists) return

    const targetFromLegacy = relative(normalizedLegacy, normalizedTarget)
    const targetIsNested = targetFromLegacy !== "" && targetFromLegacy !== ".." &&
      !targetFromLegacy.startsWith(`..${sep}`) && !isAbsolute(targetFromLegacy)
    const legacyExists = yield* fs.exists(legacyDir).pipe(Effect.orElseSucceed(() => false))
    if (targetIsNested) {
      const stage = `${legacyDir}.migrating-${basename(normalizedTarget)}`
      const stageExists = yield* fs.exists(stage).pipe(Effect.orElseSucceed(() => false))
      if (stageExists) {
        if (legacyExists) {
          const legacyEntries = yield* fs.readDirectory(legacyDir).pipe(
            Effect.catch(() => Effect.succeed(undefined))
          )
          if (legacyEntries === undefined) {
            yield* Effect.logWarning(`could not inspect ${legacyDir}; recoverable data remains at ${stage}`)
            return
          }
          if (legacyEntries.length > 0) {
            yield* Effect.logWarning(`cannot resume migration while ${legacyDir} is non-empty; recoverable data remains at ${stage}`)
            return
          }
        }
        yield* Effect.gen(function* () {
          if (!legacyExists) yield* fs.makeDirectory(legacyDir)
          yield* fs.rename(stage, dataDir)
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning(`could not resume migration into ${dataDir}; recoverable data remains at ${stage}`)
          )
        )
        return
      }
      if (!legacyExists) return
      const eventStoreExists = yield* fs.exists(join(legacyDir, "events.db")).pipe(Effect.orElseSucceed(() => false))
      if (!eventStoreExists) return
      const childEntries = yield* fs.readDirectory(legacyDir).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries, (entry) =>
            fs.stat(join(legacyDir, entry)).pipe(Effect.map((info) => ({ entry, type: info.type })))
          )
        ),
        Effect.catch(() => Effect.succeed(undefined))
      )
      if (childEntries === undefined) {
        yield* Effect.logWarning(`could not inspect ${legacyDir}; migration staging path would be ${stage}`)
        return
      }
      if (childEntries.some(({ entry, type }) => type === "Directory" && entry !== "logs")) {
        yield* Effect.logWarning(`ambiguous legacy layout at ${legacyDir}; migration staging path would be ${stage}`)
        return
      }
      yield* Effect.gen(function* () {
        yield* fs.rename(legacyDir, stage)
        yield* fs.makeDirectory(legacyDir)
        yield* fs.rename(stage, dataDir)
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning(`could not migrate ${legacyDir} -> ${dataDir}; recoverable data may remain at ${stage}`)
        )
      )
      return
    }

    if (!legacyExists) return
    yield* fs.makeDirectory(dirname(dataDir), { recursive: true }).pipe(Effect.ignore)
    yield* fs.rename(legacyDir, dataDir).pipe(
      Effect.catch(() =>
        Effect.logWarning(`could not migrate ${legacyDir} -> ${dataDir}; move it manually`)
      )
    )
  })
