import { Effect, Stream } from "effect"
import { YodeaRpcs, ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import { ProjectUseCases } from "@yodea/application/projects/use-cases"
import { ServerUseCases } from "@yodea/application/server/use-cases"
import { EventBus } from "@yodea/application/event-bus"
import { ConnectionTracker } from "@yodea/server/connection-tracker"

export const YodeaHandlers = YodeaRpcs.toLayer({
  Health: () => Effect.flatMap(ServerUseCases, (u) => u.health),
  ProjectCreate: ({ name, ensure, directory }) =>
    Effect.flatMap(ProjectUseCases, (u) => u.createProject(name, ensure, directory)).pipe(
      Effect.catchIf(
        (e): e is ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict =>
          typeof e === "object" && e !== null && "_tag" in e &&
          ((e as { _tag: string })._tag === "ProjectAlreadyExists" ||
            (e as { _tag: string })._tag === "ProjectDirectoryInvalid" ||
            (e as { _tag: string })._tag === "ProjectDirectoryConflict"),
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectRename: ({ id, name }) =>
    Effect.flatMap(ProjectUseCases, (u) => u.renameProject(id, name)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound | ProjectNameConflict =>
          typeof e === "object" && e !== null && "_tag" in e &&
          ((e as { _tag: string })._tag === "ProjectNotFound" ||
            (e as { _tag: string })._tag === "ProjectNameConflict"),
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectChangeDirectory: ({ id, directory }) =>
    Effect.flatMap(ProjectUseCases, (u) => u.changeDirectory(id, directory)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict =>
          typeof e === "object" && e !== null && "_tag" in e &&
          ((e as { _tag: string })._tag === "ProjectNotFound" ||
            (e as { _tag: string })._tag === "ProjectDirectoryInvalid" ||
            (e as { _tag: string })._tag === "ProjectDirectoryConflict"),
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectArchive: ({ id }) =>
    Effect.flatMap(ProjectUseCases, (u) => u.archiveProject(id)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectNotFound",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectRestore: ({ id }) =>
    Effect.flatMap(ProjectUseCases, (u) => u.restoreProject(id)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectNotFound",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectSetMetadata: ({ id, description, tags }) =>
    Effect.flatMap(ProjectUseCases, (u) =>
      u.setMetadata(id, {
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {})
      })
    ).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectNotFound",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectDelete: ({ id }) =>
    Effect.flatMap(ProjectUseCases, (u) => u.deleteProject(id)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectNotFound",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectList: ({ includeArchived }) => Effect.flatMap(ProjectUseCases, (u) => u.listProjects(includeArchived)).pipe(Effect.orDie),
  Connect: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tracker = yield* ConnectionTracker
        yield* tracker.onConnect
        yield* Effect.addFinalizer(() => tracker.onDisconnect)
        return Stream.make(true).pipe(Stream.concat(Stream.never))
      })
    ),
  Events: () => Stream.unwrap(Effect.map(EventBus, (bus) => bus.stream))
})
