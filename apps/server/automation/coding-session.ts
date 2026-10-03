import { Clock, Deferred, Duration, Effect, Queue, Ref } from "effect"
import { CodingError, negotiateCapabilities, redactSecrets } from "./coding-agent.js"
import type { CodingProgressEvent, CodingSessionOptions, CodingSessionResult } from "./coding-agent.js"
import { collectSessionDiff, createSessionWorktree, removeSessionWorktree } from "./coding-worktree.js"
import { spawnAcpProcess } from "./acp-transport.js"
import type { AcpHandle } from "./acp-transport.js"

export const runCodingSession = Effect.fn("CodingSession.run")(function*(options: CodingSessionOptions) {
  const startedAt = yield* Clock.currentTimeMillis
  const salt = yield* Effect.sync(() => {
    sessionSalt += 1
    return sessionSalt
  })
  const runId = `coding-${startedAt}-${salt}`
  const transcript = yield* Ref.make<ReadonlyArray<string>>([])
  const record = (kind: CodingProgressEvent["kind"], text: string) => Effect.gen(function*() {
    const clean = redactSecrets(text, options.secrets).slice(0, 4000)
    yield* Ref.update(transcript, (lines) => [...lines, clean])
    if (options.progress !== undefined) {
      yield* Queue.offer(options.progress, { sessionId: runId, kind, text: clean, at: yield* Clock.currentTimeMillis })
    }
  })
  const evidence = (stage: string) => Effect.gen(function*() {
    const lines = yield* Ref.get(transcript)
    return {
      stage,
      durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      transcriptTail: lines.slice(-20)
    }
  })
  return yield* Effect.acquireUseRelease(
    createSessionWorktree({
      worktreeRoot: options.worktreeRoot,
      repository: options.repository,
      branch: options.branch ?? `coding/${runId}`,
      now: startedAt,
      salt
    }),
    (worktree) => Effect.acquireUseRelease(
      spawnAcpProcess(options.adapter.command, worktree.path, sessionEnv(options, runId)),
      (process) => withDeadline(options, withCancel(options, driveSession(options, process, worktree.path, startedAt, transcript, record), evidence), evidence),
      (process) => process.kill
    ),
    (worktree) => removeSessionWorktree(worktree)
  )
})

let sessionSalt = 0

interface SessionEvidence {
  readonly stage: string
  readonly durationMs: number
  readonly transcriptTail: ReadonlyArray<string>
}

const sessionEnv = (options: CodingSessionOptions, runId: string): Record<string, string> => ({
  ...globalThis.process.env as Record<string, string>,
  ...options.env,
  CODING_SESSION: runId,
  CODING_ALLOWED_ACTIONS: options.allowedActions.join(",")
})

const withCancel = (
  options: CodingSessionOptions,
  drive: Effect.Effect<CodingSessionResult, CodingError>,
  evidence: (stage: string) => Effect.Effect<SessionEvidence, never>
): Effect.Effect<CodingSessionResult, CodingError> => {
  if (options.cancel === undefined) return drive
  return Effect.raceFirst(
    drive,
    Deferred.await(options.cancel).pipe(Effect.andThen(evidence("cancelled")), Effect.flatMap((seen) =>
      Effect.fail(new CodingError({ code: "cancelled", message: "Coding session was cancelled", details: seen }))))
  )
}

const withDeadline = (
  options: CodingSessionOptions,
  drive: Effect.Effect<CodingSessionResult, CodingError>,
  evidence: (stage: string) => Effect.Effect<SessionEvidence, never>
): Effect.Effect<CodingSessionResult, CodingError> =>
  Effect.raceFirst(
    drive,
    Effect.sleep(Duration.millis(options.deadlineMs)).pipe(
      Effect.andThen(evidence("timed-out")),
      Effect.flatMap((seen) => Effect.fail(new CodingError({ code: "timeout", message: "Coding session exceeded its deadline", details: seen })))
    )
  )

const driveSession = (
  options: CodingSessionOptions,
  process: AcpHandle,
  cwd: string,
  startedAt: number,
  transcript: Ref.Ref<ReadonlyArray<string>>,
  record: (kind: CodingProgressEvent["kind"], text: string) => Effect.Effect<void, never>
): Effect.Effect<CodingSessionResult, CodingError> => Effect.gen(function*() {
  yield* record("status", `worktree ${cwd}`)
  const onNotification = (method: string, params: unknown) => Effect.gen(function*() {
    const update = options.adapter.progressFromNotification(method, params)
    if (update !== null) yield* record(update.kind, update.text)
  })
  const hello = yield* exchange(process, 1, "initialize", { protocolVersion: 1, clientCapabilities: {} }, onNotification)
  yield* negotiateCapabilities(options.adapter, hello)
  const sessionId = yield* options.adapter.sessionIdFrom(
    yield* exchange(process, 2, "session/new", options.adapter.sessionRequest(cwd), onNotification)
  )
  yield* record("status", `session ${sessionId} opened`)
  const stopReason = yield* options.adapter.stopReasonFrom(
    yield* exchange(process, 3, "session/prompt", options.adapter.promptRequest(sessionId, options.task, options.allowedActions), onNotification)
  )
  yield* record("status", `prompt ${stopReason}`)
  const diff = yield* collectSessionDiff(cwd)
  yield* process.closeStdin
  const exit = yield* Effect.raceFirst(process.waitExit, Effect.sleep("5 seconds").pipe(Effect.as(null)))
  return {
    sessionId,
    agent: options.adapter.kind,
    exitStatus: exit === null ? 0 : exitStatusOf(exit),
    durationMs: (yield* Clock.currentTimeMillis) - startedAt,
    transcript: yield* Ref.get(transcript),
    diffSummary: diff.diffSummary,
    filesChanged: [...diff.filesChanged]
  }
})

const exchange = (
  process: AcpHandle,
  id: number,
  method: string,
  params: unknown,
  onNotification: (method: string, params: unknown) => Effect.Effect<void, never>
): Effect.Effect<unknown, CodingError> => Effect.gen(function*() {
  yield* process.write({ jsonrpc: "2.0", id, method, params })
  while (true) {
    const envelope = yield* process.take
    if (envelope.id !== undefined && envelope.id === id) {
      if (envelope.error !== undefined) {
        return yield* new CodingError({
          code: "agent-failed",
          message: `Agent call ${method} failed`,
          details: yield* process.stderrTail
        })
      }
      return envelope.result
    }
    if (envelope.method !== undefined) yield* onNotification(envelope.method, envelope.params)
  }
})

const exitStatusOf = (exit: { readonly code: number | null; readonly signal: string | null }): number => {
  if (exit.code !== null) return exit.code
  if (exit.signal === "SIGTERM") return 143
  if (exit.signal === "SIGKILL") return 137
  return 128
}
