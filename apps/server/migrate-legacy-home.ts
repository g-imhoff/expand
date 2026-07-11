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
    const targetExists = yield* fs.exists(normalizedTarget).pipe(Effect.orElseSucceed(() => false))
    if (targetExists) return

    const targetFromLegacy = relative(normalizedLegacy, normalizedTarget)
    const targetIsDescendant = targetFromLegacy !== "" && targetFromLegacy !== ".." &&
      !targetFromLegacy.startsWith(`..${sep}`) && !isAbsolute(targetFromLegacy)
    const targetIsDirectChild = targetIsDescendant && dirname(normalizedTarget) === normalizedLegacy
    const legacyExists = yield* fs.exists(normalizedLegacy).pipe(Effect.orElseSucceed(() => false))
    if (targetIsDescendant && !targetIsDirectChild) {
      yield* Effect.logWarning(
        `cannot migrate ${normalizedLegacy} into ${normalizedTarget}; the target must be a direct child`
      )
      return
    }
    if (targetIsDirectChild) {
      const stage = `${normalizedLegacy}.migrating-${basename(normalizedTarget)}`
      const stageExists = yield* fs.exists(stage).pipe(Effect.orElseSucceed(() => false))
      if (stageExists) {
        if (legacyExists) {
          const legacyEntries = yield* fs.readDirectory(normalizedLegacy).pipe(
            Effect.catch(() => Effect.succeed(undefined))
          )
          if (legacyEntries === undefined) {
            yield* Effect.logWarning(`could not inspect ${normalizedLegacy}; recoverable data remains at ${stage}`)
            return
          }
          if (legacyEntries.length > 0) {
            yield* Effect.logWarning(`cannot resume migration while ${normalizedLegacy} is non-empty; recoverable data remains at ${stage}`)
            return
          }
        }
        yield* Effect.gen(function* () {
          if (!legacyExists) yield* fs.makeDirectory(normalizedLegacy)
          yield* fs.rename(stage, normalizedTarget)
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning(`could not resume migration into ${normalizedTarget}; recoverable data remains at ${stage}`)
          )
        )
        return
      }
      if (!legacyExists) return
      const eventStoreExists = yield* fs.exists(join(normalizedLegacy, "events.db")).pipe(Effect.orElseSucceed(() => false))
      if (!eventStoreExists) return
      const childEntries = yield* fs.readDirectory(normalizedLegacy).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries, (entry) =>
            fs.stat(join(normalizedLegacy, entry)).pipe(Effect.map((info) => ({ entry, type: info.type })))
          )
        ),
        Effect.catch(() => Effect.succeed(undefined))
      )
      if (childEntries === undefined) {
        yield* Effect.logWarning(`could not inspect ${normalizedLegacy}; migration staging path would be ${stage}`)
        return
      }
      if (childEntries.some(({ entry, type }) => type === "Directory" && entry !== "logs")) {
        yield* Effect.logWarning(`ambiguous legacy layout at ${normalizedLegacy}; migration staging path would be ${stage}`)
        return
      }
      yield* Effect.gen(function* () {
        yield* fs.rename(normalizedLegacy, stage)
        yield* fs.makeDirectory(normalizedLegacy)
        yield* fs.rename(stage, normalizedTarget)
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning(`could not migrate ${normalizedLegacy} -> ${normalizedTarget}; recoverable data may remain at ${stage}`)
        )
      )
      return
    }

    if (!legacyExists) return
    yield* fs.makeDirectory(dirname(normalizedTarget), { recursive: true }).pipe(Effect.ignore)
    yield* fs.rename(normalizedLegacy, normalizedTarget).pipe(
      Effect.catch(() =>
        Effect.logWarning(`could not migrate ${normalizedLegacy} -> ${normalizedTarget}; move it manually`)
      )
    )
  })
