import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Clock, Data, Effect, Schema } from "effect"
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
  Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const child = yield* Effect.try({
      try: () =>
        spawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: { PATH: globalThis.process.env["PATH"] ?? "", ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true
        }),
      catch: () => new AcpTransportError({ code: "spawn", message: "ACP agent failed to spawn", durationMs: 0, transcript: [], exitStatus: undefined })
    })
    const state: TransportState = { lines: [], updates: [], buffer: "" }
    const snapshotTranscript = (): ReadonlyArray<string> => boundTranscript(state.updates)
    const stdout = child.stdout
    if (stdout === null) {
      const nowNoStdout = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => {
        try {
          killProcessGroup(child)
        } catch {
          return
        }
      })
      return yield* new AcpTransportError({ code: "io", message: "ACP agent has no stdout", durationMs: nowNoStdout - startedAt, transcript: snapshotTranscript(), exitStatus: child.exitCode ?? undefined })
    }
    const stderr = child.stderr
    if (stderr !== null) {
      stderr.setEncoding("utf-8")
      stderr.on("data", discardStderr)
    }
    stdout.setEncoding("utf-8")
    const onData = (chunk: string): void => {
      state.buffer += chunk
      if (state.buffer.length > MAX_BUFFER_BYTES) state.buffer = state.buffer.slice(-MAX_BUFFER_BYTES)
      let index = state.buffer.indexOf("\n")
      while (index >= 0) {
        const line = state.buffer.slice(0, index).trim()
        state.buffer = state.buffer.slice(index + 1)
        if (line.length > 0) recordLine(state, line)
        index = state.buffer.indexOf("\n")
      }
    }
    stdout.on("data", onData as (chunk: unknown) => void)
    let cancelSession: string | null = null
    const cleanup = Effect.gen(function*() {
      if (cancelSession !== null && child.exitCode === null && child.stdin !== null) {
        yield* sendCancelLine(child, cancelSession).pipe(Effect.ignore)
        let waited = 0
        while (child.exitCode === null && waited < 1000) {
          yield* Effect.sleep("50 millis")
          waited += 50
        }
      }
      yield* Effect.sync(() => {
        stdout.removeListener("data", onData as (chunk: unknown) => void)
        try {
          if (stderr !== null) {
            stderr.removeListener("data", discardStderr)
            stderr.destroy()
          }
        } catch {}
        try {
          child.stdin?.destroy()
        } catch {}
        try {
          stdout.destroy()
        } catch {}
      })
      yield* Effect.sync(() => {
        try {
          if (child.exitCode === null) killProcessGroup(child)
        } catch {}
      })
      let settled = 0
      while (child.exitCode === null && settled < 1000) {
        yield* Effect.sleep("50 millis")
        settled += 50
      }
    })
    const session = Effect.gen(function*() {
      yield* sendLine(child, { jsonrpc: "2.0", id: freshId(), method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }, state, input.timeoutMs, "initialize", startedAt)
      const createdId = freshId()
      const created = yield* sendLine(child, { jsonrpc: "2.0", id: createdId, method: "session/new", params: { cwd: options.cwd, mcpServers: [] } }, state, input.timeoutMs, "session/new", startedAt)
      const sessionId = extractSessionId(created)
      cancelSession = sessionId
      if (sessionId === null) {
        const nowNoSession = yield* Clock.currentTimeMillis
        return yield* new AcpTransportError({ code: "protocol", message: "ACP session/new returned no sessionId", durationMs: nowNoSession - startedAt, transcript: snapshotTranscript(), exitStatus: child.exitCode ?? undefined })
      }
      const promptId = freshId()
      const promptResult = yield* sendLine(
        child,
        { jsonrpc: "2.0", id: promptId, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: input.prompt }] } },
        state,
        input.timeoutMs,
        "session/prompt",
        startedAt
      )
      const endedAt = yield* Clock.currentTimeMillis
      const transcript = boundTranscript([...state.updates.slice(0, 49), `result: ${encodeLine(promptResult).slice(0, 1000)}`])
      if (child.exitCode !== null && child.exitCode !== 0) {
        return yield* new AcpTransportError({ code: "protocol", message: `ACP agent exited with status ${child.exitCode}`, durationMs: endedAt - startedAt, transcript, exitStatus: child.exitCode })
      }
      return { sessionId, transcript, exitStatus: child.exitCode ?? 0, durationMs: endedAt - startedAt }
    })
    return yield* session.pipe(Effect.ensuring(cleanup))
  })
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
const sendCancelLine = (child: ChildProcess, sessionId: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      const stdin = child.stdin
      if (stdin === null || child.exitCode !== null) return
      try {
        stdin.write(encodeLine({ jsonrpc: "2.0", id: freshId(), method: "session/cancel", params: { sessionId } }) + "\n")
      } catch {
        return
      }
    } catch {
      return
    }
  })
const killProcessGroup = (child: ChildProcess): void => {
  try {
    const pid = child.pid
    if (pid !== undefined) {
      try {
        globalThis.process.kill(-pid, "SIGKILL")
        return
      } catch {}
    }
  } catch {}
  try {
    if (child.exitCode === null) child.kill("SIGKILL")
  } catch {}
}
const sendLine = (
  child: ChildProcess,
  message: { readonly jsonrpc: string; readonly id: number; readonly method: string; readonly params: unknown },
  state: TransportState,
  timeoutMs: number,
  label: string,
  sessionStartedAt: number
): Effect.Effect<unknown, AcpTransportError> =>
  Effect.gen(function*() {
    const stdin = child.stdin
    if (stdin === null) {
      const nowNoStdin = yield* Clock.currentTimeMillis
      return yield* new AcpTransportError({ code: "io", message: `ACP ${label} has no stdin`, durationMs: nowNoStdin - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: child.exitCode ?? undefined })
    }
    const line = encodeLine(message)
    const nowBeforeWrite = yield* Clock.currentTimeMillis
    const written = yield* Effect.try({
      try: () => stdin.write(`${line}\n`),
      catch: () => new AcpTransportError({ code: "io", message: `ACP ${label} send failed`, durationMs: nowBeforeWrite - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: child.exitCode ?? undefined })
    })
    void written
    const sendStartedAt = yield* Clock.currentTimeMillis
    const deadline = sendStartedAt + timeoutMs
    while (true) {
      const index = state.lines.findIndex((entry) => entry.id === message.id)
      if (index >= 0) {
        const entry = state.lines[index]!
        state.lines.splice(index, 1)
        if (entry.error !== null) {
          const nowEntry = yield* Clock.currentTimeMillis
          if (entry.error.includes("timed out") || entry.error.includes("timeout")) {
            return yield* new AcpTransportError({ code: "timeout", message: `ACP ${label} timed out after ${nowEntry - sendStartedAt}ms`, durationMs: nowEntry - sendStartedAt, transcript: boundTranscript(state.updates), exitStatus: child.exitCode ?? undefined })
          }
          return yield* new AcpTransportError({ code: "protocol", message: entry.error.slice(0, 500), durationMs: nowEntry - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: child.exitCode ?? undefined })
        }
        return entry.result
      }
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) {
        return yield* new AcpTransportError({ code: "timeout", message: `ACP ${label} timed out after ${now - sendStartedAt}ms with ${state.updates.length} updates`, durationMs: now - sendStartedAt, transcript: boundTranscript(state.updates), exitStatus: child.exitCode ?? undefined })
      }
      if (child.exitCode !== null) {
        return yield* new AcpTransportError({ code: "protocol", message: `ACP agent exited during ${label}`, durationMs: now - sessionStartedAt, transcript: boundTranscript(state.updates), exitStatus: child.exitCode })
      }
      yield* Effect.sleep("10 millis")
    }
  })
const discardStderr = (): void => {}
const extractSessionId = (value: unknown): string | null => {
  if (typeof value === "object" && value !== null && "sessionId" in value) {
    const candidate = (value as Record<string, unknown>)["sessionId"]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return null
}
