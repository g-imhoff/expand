import { NodeServices } from "@effect/platform-node"
import { Clock, Data, Effect, Schema, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
export class AcpTransportError extends Data.TaggedError("AcpTransportError")<{
  readonly code: "spawn" | "protocol" | "timeout" | "cancelled" | "io"
  readonly message: string
  readonly durationMs?: number | undefined
  readonly transcript?: ReadonlyArray<string> | undefined
  readonly exitStatus?: number | undefined
}> {}
export interface AcpSpawnOptions {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Record<string, string>
}
export interface AcpSessionHandle {
  readonly sessionId: string
  readonly transcript: ReadonlyArray<string>
  readonly exitStatus: number
  readonly durationMs: number
}
export const runAcpPrompt = (
  options: AcpSpawnOptions,
  input: { readonly prompt: string; readonly timeoutMs: number }
): Effect.Effect<AcpSessionHandle, AcpTransportError> =>
  Effect.scoped(Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const handle = yield* ChildProcess.make(options.command, options.args, {
      cwd: options.cwd,
      env: { PATH: globalThis.process.env["PATH"] ?? "", ...options.env },
      extendEnv: false,
      stdin: { stream: "pipe", endOnDone: false },
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      killSignal: "SIGKILL"
    }).pipe(Effect.mapError(() => new AcpTransportError({
      code: "spawn", message: "ACP agent failed to spawn", durationMs: 0, transcript: [], exitStatus: undefined
    })))
    const state: TransportState = {
      lines: [], updates: [], buffer: "", stdinFailed: false, exited: false, exitStatus: undefined
    }
    const child: AcpChild = { handle, state }
    yield* handle.exitCode.pipe(
      Effect.match({
        onFailure: () => { state.exited = true },
        onSuccess: (status) => {
          state.exitStatus = Number(status)
          state.exited = true
        }
      }),
      Effect.forkScoped
    )
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.sync(() => {
        state.buffer += chunk
        if (state.buffer.length > MAX_BUFFER_BYTES) state.buffer = state.buffer.slice(-MAX_BUFFER_BYTES)
        let index = state.buffer.indexOf("\n")
        while (index >= 0) {
          const line = state.buffer.slice(0, index).trim()
          state.buffer = state.buffer.slice(index + 1)
          if (line.length > 0) recordLine(state, line)
          index = state.buffer.indexOf("\n")
        }
      })),
      Effect.ignore,
      Effect.forkScoped
    )
    yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped)
    let cancelSession: string | null = null
    const cleanup = Effect.gen(function*() {
      if (cancelSession !== null && !state.exited && !state.stdinFailed) {
        yield* sendCancelLine(child, cancelSession)
        let waited = 0
        while (!state.exited && !state.stdinFailed && waited < 1000) {
          yield* Effect.sleep("50 millis")
          waited += 50
        }
      }
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
    })
    const session = Effect.gen(function*() {
      yield* Effect.sleep("25 millis")
      yield* sendLine(child, { jsonrpc: "2.0", id: freshId(), method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }, input.timeoutMs, "initialize", startedAt)
      const createdId = freshId()
      const created = yield* sendLine(child, { jsonrpc: "2.0", id: createdId, method: "session/new", params: { cwd: options.cwd, mcpServers: [] } }, input.timeoutMs, "session/new", startedAt)
      const sessionId = extractSessionId(created)
      cancelSession = sessionId
      if (sessionId === null) {
        const nowNoSession = yield* Clock.currentTimeMillis
        return yield* new AcpTransportError({ code: "protocol", message: "ACP session/new returned no sessionId", durationMs: nowNoSession - startedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
      }
      const promptResult = yield* sendLine(
        child,
        { jsonrpc: "2.0", id: freshId(), method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: input.prompt }] } },
        input.timeoutMs,
        "session/prompt",
        startedAt
      )
      const endedAt = yield* Clock.currentTimeMillis
      const transcript = boundTranscript([...state.updates.slice(0, 49), `result: ${encodeLine(promptResult).slice(0, 1000)}`])
      if (state.exitStatus !== undefined && state.exitStatus !== 0) {
        return yield* new AcpTransportError({ code: "protocol", message: `ACP agent exited with status ${state.exitStatus}`, durationMs: endedAt - startedAt, transcript, exitStatus: state.exitStatus })
      }
      return { sessionId, transcript, exitStatus: state.exitStatus ?? 0, durationMs: endedAt - startedAt }
    })
    return yield* session.pipe(Effect.ensuring(cleanup))
  })).pipe(Effect.provide(NodeServices.layer))

const JsonFromString = Schema.fromJsonString(Schema.Unknown)
const encodeLine = Schema.encodeSync(JsonFromString)
const decodeLine = Schema.decodeUnknownSync(JsonFromString)
let requestCounter = 0
const MAX_BUFFER_BYTES = 1000000
const MAX_PENDING_RESPONSES = 200
const freshId = (): number => {
  requestCounter += 1
  return requestCounter
}
interface TransportState {
  readonly lines: Array<{ readonly id: number; readonly result: unknown; readonly error: string | null }>
  readonly updates: Array<string>
  buffer: string
  stdinFailed: boolean
  exited: boolean
  exitStatus: number | undefined
}
interface AcpChild {
  readonly handle: ChildProcessSpawner.ChildProcessHandle
  readonly state: TransportState
}
const boundTranscript = (lines: ReadonlyArray<string>): Array<string> => {
  const sliced = lines.slice(0, 50)
  const out: Array<string> = []
  let total = 0
  for (const line of sliced) {
    if (total >= 4000) break
    const remaining = 4000 - total
    if (line.length <= remaining) {
      out.push(line)
      total += line.length
    } else {
      out.push(line.slice(0, remaining))
      total += remaining
    }
  }
  return out
}
const recordLine = (state: TransportState, line: string): void => {
  let value: unknown
  try {
    value = decodeLine(line)
  } catch {
    return
  }
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  if (typeof record["id"] === "number") {
    const id = record["id"] as number
    if ("error" in record && record["error"] !== undefined && record["error"] !== null) {
      const detail = record["error"] as { message?: unknown }
      const message = typeof detail.message === "string" ? detail.message : "ACP request failed"
      if (state.lines.length >= MAX_PENDING_RESPONSES) state.lines.shift()
      state.lines.push({ id, result: null, error: message })
    } else {
      if (state.lines.length >= MAX_PENDING_RESPONSES) state.lines.shift()
      state.lines.push({ id, result: record["result"] ?? null, error: null })
    }
    return
  }
  if (typeof record["method"] === "string") {
    if (state.updates.length < 100) state.updates.push(line.slice(0, 2000))
  }
}
const sendCancelLine = (child: AcpChild, sessionId: string): Effect.Effect<void> =>
  Stream.succeed(new TextEncoder().encode(encodeLine({ jsonrpc: "2.0", id: freshId(), method: "session/cancel", params: { sessionId } }) + "\n")).pipe(
    Stream.run(child.handle.stdin),
    Effect.ignore
  )
const sendLine = (
  child: AcpChild,
  message: { readonly jsonrpc: string; readonly id: number; readonly method: string; readonly params: unknown },
  timeoutMs: number,
  label: string,
  sessionStartedAt: number
): Effect.Effect<unknown, AcpTransportError> =>
  Effect.gen(function*() {
    const state = child.state
    const nowBeforeWrite = yield* Clock.currentTimeMillis
    if (state.exited) {
      return yield* new AcpTransportError({ code: "protocol", message: `ACP agent exited during ${label}`, durationMs: nowBeforeWrite - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
    }
    if (state.stdinFailed) {
      return yield* new AcpTransportError({ code: "io", message: `ACP ${label} send failed`, durationMs: nowBeforeWrite - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
    }
    yield* Stream.succeed(new TextEncoder().encode(encodeLine(message) + "\n")).pipe(
      Stream.run(child.handle.stdin),
      Effect.mapError(() => {
        state.stdinFailed = true
        return new AcpTransportError({ code: "io", message: `ACP ${label} send failed`, durationMs: nowBeforeWrite - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
      })
    )
    const sendStartedAt = yield* Clock.currentTimeMillis
    const deadline = sendStartedAt + timeoutMs
    while (true) {
      if (state.stdinFailed) {
        const nowFailed = yield* Clock.currentTimeMillis
        return yield* new AcpTransportError({ code: "io", message: `ACP ${label} send failed`, durationMs: nowFailed - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
      }
      const index = state.lines.findIndex((entry) => entry.id === message.id)
      if (index >= 0) {
        const entry = state.lines[index]!
        state.lines.splice(index, 1)
        if (entry.error !== null) {
          const nowEntry = yield* Clock.currentTimeMillis
          if (entry.error.includes("timed out") || entry.error.includes("timeout")) {
            return yield* new AcpTransportError({ code: "timeout", message: `ACP ${label} timed out after ${nowEntry - sendStartedAt}ms`, durationMs: nowEntry - sendStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
          }
          return yield* new AcpTransportError({ code: "protocol", message: entry.error.slice(0, 500), durationMs: nowEntry - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
        }
        return entry.result
      }
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) {
        return yield* new AcpTransportError({ code: "timeout", message: `ACP ${label} timed out after ${now - sendStartedAt}ms with ${state.updates.length} updates`, durationMs: now - sendStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
      }
      if (state.exited) {
        return yield* new AcpTransportError({ code: "protocol", message: `ACP agent exited during ${label}`, durationMs: now - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: state.exitStatus })
      }
      yield* Effect.sleep("10 millis")
    }
  })
const extractSessionId = (value: unknown): string | null => {
  if (typeof value === "object" && value !== null && "sessionId" in value) {
    const candidate = (value as Record<string, unknown>)["sessionId"]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return null
}
