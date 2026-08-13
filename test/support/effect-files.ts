import { Effect, FileSystem, Path, Schema, type Scope } from "effect"

export class FixtureFileError extends Schema.TaggedErrorClass<FixtureFileError>()(
  "FixtureFileError",
  {
    path: Schema.String,
    cause: Schema.Defect
  }
) {}

export const makeTempDirectoryScoped = Effect.fn("TestSupport.makeTempDirectoryScoped")(
  (prefix: string): Effect.Effect<string, FixtureFileError, FileSystem.FileSystem | Scope.Scope> =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
      Effect.mapError((cause) => new FixtureFileError({ path: prefix, cause }))
    )
)

export const writeFixture = Effect.fn("TestSupport.writeFixture")(
  function*(directory: string, file: string, content: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = path.join(directory, file)
    yield* fs.writeFileString(target, content).pipe(
      Effect.mapError((cause) => new FixtureFileError({ path: target, cause }))
    )
    return target
  }
)
