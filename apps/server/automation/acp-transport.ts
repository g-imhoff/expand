import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Clock, Data, Effect, Schema } from "effect"

export class AcpTransportError extends Data.TaggedError("AcpTransportError")<{
  readonly code: "spawn" | "protocol" | "timeout" | "cancelled" | "io"
  readonly message: string
  readonly durationMs?: number
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
          stdio: ["pipe", "pipe", "pipe"]
        }),
      catch: () => new AcpTransportError({ code: "spawn", message: "ACP agent failed to spawn" })
    })
    const state: TransportState = { lines: [], updates: [], buffer: "" }
    const stdout = child.stdout
    if (stdout === null) {
      yield* Effect.sync(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          return
        }
      })
      return yield* new AcpTransportError({ code: "io", message: "ACP agent has no stdout" })
    }
    const stderr = child.stderr
    if (stderr !== null) {
      stderr.setEncoding("utf-8")
      stderr.on("data", discardStderr)
    }
    stdout.setEncoding("utf-8")
    const onData = (chunk: string): void => {
      state.buffer += chunk
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
      yield* Effect.sync(() => {
        try {
          if (cancelSession !== null && child.exitCode === null) {
            child.stdin?.write(encodeLine({ jsonrpc: "2.0", id: freshId(), method: "session/cancel", params: { sessionId: cancelSession } }) + "\n")
          }
        } catch {}
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
        try {
          if (child.exitCode === null) child.kill("SIGKILL")
        } catch {}
      })
      let waited = 0
      while (child.exitCode === null && waited < 1000) {
        yield* Effect.sleep("50 millis")
        waited += 50
      }
    })
    const session = Effect.gen(function*() {
      yield* sendLine(child, { jsonrpc: "2.0", id: freshId(), method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }, state, input.timeoutMs, "initialize")
      const createdId = freshId()
      const created = yield* sendLine(child, { jsonrpc: "2.0", id: createdId, method: "session/new", params: { cwd: options.cwd, mcpServers: [] } }, state, input.timeoutMs, "session/new")
      const sessionId = extractSessionId(created)
      cancelSession = sessionId
      if (sessionId === null) {
        return yield* new AcpTransportError({ code: "protocol", message: "ACP session/new returned no sessionId" })
      }
      const promptId = freshId()
      const promptResult = yield* sendLine(
        child,
        { jsonrpc: "2.0", id: promptId, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: input.prompt }] } },
        state,
        input.timeoutMs,
        "session/prompt"
      )
      const endedAt = yield* Clock.currentTimeMillis
      const transcript = [...state.updates.slice(0, 50), `result: ${encodeLine(promptResult).slice(0, 1000)}`]
      if (child.exitCode !== null && child.exitCode !== 0) {
        return yield* new AcpTransportError({ code: "protocol", message: `ACP agent exited with status ${child.exitCode}` })
      }
      return { sessionId, transcript, exitStatus: child.exitCode ?? 0, durationMs: endedAt - startedAt }
    })
    return yield* session.pipe(Effect.ensuring(cleanup))
  })

const JsonFromString = Schema.fromJsonString(Schema.Unknown)
const encodeLine = Schema.encodeSync(JsonFromString)
const decodeLine = Schema.decodeUnknownSync(JsonFromString)

let requestCounter = 0
const freshId = (): number => {
  requestCounter += 1
  return requestCounter
}

interface TransportState {
  readonly lines: Array<{ readonly id: number; readonly result: unknown; readonly error: string | null }>
  readonly updates: Array<string>
  buffer: string
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
      state.lines.push({ id, result: null, error: message })
    } else {
      state.lines.push({ id, result: record["result"] ?? null, error: null })
    }
    return
  }
  if (typeof record["method"] === "string") {
    if (state.updates.length < 100) state.updates.push(line.slice(0, 2000))
  }
}

const sendLine = (
  child: ChildProcess,
  message: { readonly jsonrpc: string; readonly id: number; readonly method: string; readonly params: unknown },
  state: TransportState,
  timeoutMs: number,
  label: string
): Effect.Effect<unknown, AcpTransportError> =>
  Effect.gen(function*() {
    const stdin = child.stdin
    if (stdin === null) {
      return yield* new AcpTransportError({ code: "io", message: `ACP ${label} has no stdin` })
    }
    const line = encodeLine(message)
    const written = yield* Effect.try({
      try: () => stdin.write(`${line}\n`),
      catch: () => new AcpTransportError({ code: "io", message: `ACP ${label} send failed` })
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
          if (entry.error.includes("timed out") || entry.error.includes("timeout")) {
            const elapsedTimeout = yield* Clock.currentTimeMillis
            return yield* new AcpTransportError({ code: "timeout", message: `ACP ${label} timed out after ${elapsedTimeout - sendStartedAt}ms`, durationMs: elapsedTimeout - sendStartedAt })
          }
          return yield* new AcpTransportError({ code: "protocol", message: entry.error.slice(0, 500) })
        }
        return entry.result
      }
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) {
        return yield* new AcpTransportError({ code: "timeout", message: `ACP ${label} timed out after ${now - sendStartedAt}ms with ${state.updates.length} updates`, durationMs: now - sendStartedAt })
      }
      if (child.exitCode !== null) {
        return yield* new AcpTransportError({ code: "protocol", message: `ACP agent exited during ${label}` })
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
