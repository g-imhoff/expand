import { Effect, Stream } from "effect"
import { YodeaRpcs, ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import { UseCases } from "@yodea/application/use-cases"
import { EventBus } from "@yodea/application/event-bus"
import { ConnectionTracker } from "@yodea/server/connection-tracker"

export const YodeaHandlers = YodeaRpcs.toLayer({
  Health: () => Effect.flatMap(UseCases, (u) => u.health),
  // Pass `ensure`; propagate the typed ProjectAlreadyExists to the RPC error
  // channel, but die on infrastructural failures (SqlError/SchemaError) — those
  // are server defects, not client-facing errors (matches the contract).
  //
  // The first arg is a Refinement keyed on the ProjectAlreadyExists `_tag`, so
  // `catchIf` narrows the residual error channel: the matched branch re-fails it
  // (keeping it typed), and the `orElse` branch dies on everything else
  // (Exclude<E, ProjectAlreadyExists> = SqlError | SchemaError). The resulting
  // error channel is exactly ProjectAlreadyExists, matching the RPC contract.
  ProjectCreate: ({ name, ensure }) =>
    Effect.flatMap(UseCases, (u) => u.createProject(name, ensure)).pipe(
      Effect.catchIf(
        (e): e is ProjectAlreadyExists =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectAlreadyExists",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  // Rename maps BOTH allowed domain tags (ProjectNotFound, ProjectNameConflict)
  // to the typed RPC error channel; everything else (SqlError/SchemaError) dies.
  // The refinement returns true for every allowed _tag — the ProjectCreate pattern
  // widened to two tags.
  ProjectRename: ({ id, name }) =>
    Effect.flatMap(UseCases, (u) => u.renameProject(id, name)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound | ProjectNameConflict =>
          typeof e === "object" && e !== null && "_tag" in e &&
          ((e as { _tag: string })._tag === "ProjectNotFound" ||
            (e as { _tag: string })._tag === "ProjectNameConflict"),
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  // Change-directory maps all THREE allowed domain tags (ProjectNotFound,
  // ProjectDirectoryInvalid, ProjectDirectoryConflict) to the typed RPC error
  // channel; everything else (SqlError/SchemaError) dies. Same shape as Rename,
  // widened to three tags.
  ProjectChangeDirectory: ({ id, directory }) =>
    Effect.flatMap(UseCases, (u) => u.changeDirectory(id, directory)).pipe(
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
  // Archive/restore each map the single allowed domain tag (ProjectNotFound) to
  // the typed RPC error channel; everything else (SqlError/SchemaError) dies.
  // Same shape as ProjectCreate, refined on one tag.
  ProjectArchive: ({ id }) =>
    Effect.flatMap(UseCases, (u) => u.archiveProject(id)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectNotFound",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectRestore: ({ id }) =>
    Effect.flatMap(UseCases, (u) => u.restoreProject(id)).pipe(
      Effect.catchIf(
        (e): e is ProjectNotFound =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectNotFound",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
  ProjectList: ({ includeArchived }) => Effect.flatMap(UseCases, (u) => u.listProjects(includeArchived)).pipe(Effect.orDie),
  // Presence channel = the I-4 connection. onConnect when the subscription is
  // established; emit one `true` so the client can confirm before doing work;
  // onDisconnect (via finalizer) when the stream's scope closes on socket drop.
  // `Stream.never` keeps the subscription open after the marker. In v4 the
  // wrapped effect requires Scope, and `Stream.unwrap` discharges it.
  Connect: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tracker = yield* ConnectionTracker
        yield* tracker.onConnect
        yield* Effect.addFinalizer(() => tracker.onDisconnect)
        return Stream.make(true).pipe(Stream.concat(Stream.never))
      })
    ),
  // Live domain-event stream (read-model frontends). No presence side effects.
  Events: () => Stream.unwrap(Effect.map(EventBus, (bus) => bus.stream))
})
