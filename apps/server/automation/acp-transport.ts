import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Effect, Schema } from "effect"
import { CodingError } from "./coding-agent.js"

export interface AcpEnvelope {
  readonly id?: string | number
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

export interface ProcessExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface AcpHandle {
  readonly write: (value: unknown) => Effect.Effect<void, CodingError>
  readonly take: Effect.Effect<AcpEnvelope, CodingError>
  readonly waitExit: Effect.Effect<ProcessExit, CodingError>
  readonly stderrTail: Effect.Effect<string, never>
  readonly kill: Effect.Effect<void, never>
  readonly closeStdin: Effect.Effect<void, never>
}

export const spawnAcpProcess = Effect.fn("AcpTransport.spawn")(function*(
  command: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>
) {
  const executable = command[0]
  if (executable === undefined) return yield* new CodingError({ code: "transport", message: "Agent command is empty" })
  const child = yield* Effect.try({
    try: () => spawn(executable, [...command.slice(1)], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
    catch: () => new CodingError({ code: "transport", message: `Could not start agent ${executable}` })
  })
  return yield* Effect.sync(() => attachBroker(child, executable))
})

const RpcEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown)
})
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type TakeResume = (effect: Effect.Effect<string, CodingError>) => void
type ExitResume = (effect: Effect.Effect<ProcessExit, CodingError>) => void

const attachBroker = (child: ChildProcess, executable: string): AcpHandle => {
  let buffer = ""
  let failed: CodingError | null = null
  let exit: ProcessExit | null = null
  let stderr = ""
  const lines: Array<string> = []
  const lineWaiters: Array<TakeResume> = []
  const exitWaiters: Array<ExitResume> = []
  const failBroker = (error: CodingError) => {
    if (failed !== null) return
    failed = error
    for (const resume of lineWaiters.splice(0)) resume(Effect.fail(error))
    for (const resume of exitWaiters.splice(0)) resume(Effect.fail(error))
  }
  const pumpLines = () => {
    while (lineWaiters.length > 0 && lines.length > 0) {
      const resume = lineWaiters.shift()!
      const line = lines.shift()!
      resume(Effect.succeed(line))
    }
  }
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk)
    if (buffer.length > 1048576) {
      failBroker(new CodingError({ code: "transport", message: `Agent ${executable} overflowed its output` }))
      return
    }
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    for (const part of parts) {
      if (part.trim().length === 0) continue
      lines.push(part)
    }
    pumpLines()
  })
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-65536)
  })
  child.on("error", (cause) => {
    failBroker(new CodingError({ code: "transport", message: `Agent ${executable} failed: ${String(cause)}` }))
  })
  child.on("close", (code, signal) => {
    exit = { code, signal }
    for (const resume of exitWaiters.splice(0)) resume(Effect.succeed(exit))
    if (lines.length === 0 && buffer.trim().length === 0) {
      failBroker(new CodingError({ code: "transport", message: `Agent ${executable} closed unexpectedly`, details: stderr.slice(-2000) }))
    } else {
      if (buffer.trim().length > 0) lines.push(buffer)
      buffer = ""
      pumpLines()
      failBroker(new CodingError({ code: "transport", message: `Agent ${executable} closed unexpectedly`, details: stderr.slice(-2000) }))
    }
  })
  const takeLine: Effect.Effect<string, CodingError> = Effect.callback<string, CodingError>((resume) => {
    lineWaiters.push(resume)
    pumpLines()
    return Effect.sync(() => {
      const index = lineWaiters.indexOf(resume)
      if (index !== -1) lineWaiters.splice(index, 1)
    })
  })
  return {
    write: (value: unknown) => Effect.gen(function*() {
      const line = yield* Effect.try({
        try: () => encodeRequest(value),
        catch: () => new CodingError({ code: "transport", message: `Agent ${executable} request is not encodable` })
      })
      const stdin = child.stdin
      if (stdin === null || stdin.destroyed || exit !== null) {
        return yield* new CodingError({ code: "transport", message: `Agent ${executable} is not accepting input` })
      }
      yield* Effect.sync(() => {
        stdin.write(`${line}\n`)
      })
    }),
    take: takeLine.pipe(Effect.flatMap((line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(RpcEnvelopeSchema))(line).pipe(
        Effect.mapError(() => new CodingError({ code: "transport", message: `Agent ${executable} sent an undecodable message` })),
        Effect.map((parsed): AcpEnvelope => ({
          ...(parsed.id === undefined ? {} : { id: parsed.id }),
          ...(parsed.method === undefined ? {} : { method: parsed.method }),
          ...(parsed.params === undefined ? {} : { params: parsed.params }),
          ...(parsed.result === undefined ? {} : { result: parsed.result }),
          ...(parsed.error === undefined ? {} : { error: parsed.error })
        }))
      )
    )),
    waitExit: Effect.callback<ProcessExit, CodingError>((resume) => {
      if (exit !== null) {
        resume(Effect.succeed(exit))
        return
      }
      if (failed !== null) {
        resume(Effect.fail(failed))
        return
      }
      exitWaiters.push(resume)
      return Effect.sync(() => {
        const index = exitWaiters.indexOf(resume)
        if (index !== -1) exitWaiters.splice(index, 1)
      })
    }),
    stderrTail: Effect.sync(() => stderr.slice(-2000)),
    kill: Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }),
    closeStdin: Effect.sync(() => {
      const stdin = child.stdin
      if (stdin !== null && !stdin.destroyed) stdin.end()
    })
  }
}
