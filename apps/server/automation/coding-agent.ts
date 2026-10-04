import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { Clock, Data, Effect, Schema } from "effect"
import { runAcpPrompt } from "./acp-transport.js"
import type { AcpTransportError } from "./acp-transport.js"

export class CodingAgentError extends Data.TaggedError("CodingAgentError")<{
  readonly code: "unknown-agent" | "capability" | "worktree" | "timeout" | "cancelled" | "failed" | "invalid"
  readonly message: string
  readonly transcript?: ReadonlyArray<string> | undefined
  readonly exitStatus?: number | undefined
  readonly durationMs?: number | undefined
}> {}

export interface CodingAgentSpawnInput {
  readonly worktree: string
  readonly prompt: string
  readonly timeoutMs: number
  readonly env: Record<string, string>
}

export interface CodingAgentSession {
  readonly sessionId: string
  readonly transcript: ReadonlyArray<string>
  readonly exitStatus: number
  readonly durationMs: number
}

export interface CodingAgentAdapter {
  readonly kind: string
  readonly capabilities: ReadonlyArray<string>
  readonly spawn: (input: CodingAgentSpawnInput) => Effect.Effect<CodingAgentSession, AcpTransportError>
}

export interface CodingExecutionInput {
  readonly runId: string
  readonly repository: string
  readonly prompt: string
  readonly agentKind: string
  readonly requestedCapabilities: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly tokenEnv: Record<string, string>
}

export interface CodingExecutionResult extends CodingAgentSession {
  readonly agentKind: string
  readonly repository: string
  readonly worktree: string
  readonly diffSummary: string
}

export const registerCodingAdapter = (adapter: CodingAgentAdapter): void => {
  adapters.set(adapter.kind, adapter)
}

export const clearCodingAdapters = (): void => {
  adapters.clear()
}

export const resolveCodingAdapter = (
  kind: string,
  requested: ReadonlyArray<string>
): Effect.Effect<CodingAgentAdapter, CodingAgentError> =>
  Effect.gen(function*() {
    const adapter = adapters.get(kind)
    if (adapter === undefined) {
      return yield* new CodingAgentError({ code: "unknown-agent", message: `Unknown coding agent: ${kind}` })
    }
    for (const capability of requested) {
      if (!adapter.capabilities.includes(capability)) {
        return yield* new CodingAgentError({
          code: "capability",
          message: `Agent ${kind} does not support capability ${capability}`
        })
      }
    }
    return adapter
  })

export const makeOpencodeAdapter = (command: string, args: ReadonlyArray<string>): CodingAgentAdapter => ({
  kind: "opencode",
  capabilities: ["execute", "worktree", "transcript", "diff"],
  spawn: (input) =>
    runAcpPrompt({ command, args, cwd: input.worktree, env: input.env }, { prompt: input.prompt, timeoutMs: input.timeoutMs }).pipe(
      Effect.map((session) => ({
        sessionId: session.sessionId,
        transcript: session.transcript,
        exitStatus: session.exitStatus,
        durationMs: session.durationMs
      }))
    )
})

export const makeStubAdapter = (command: string, args: ReadonlyArray<string>, kind = "opencode"): CodingAgentAdapter => ({
  kind,
  capabilities: ["execute", "worktree", "transcript", "diff"],
  spawn: (input) =>
    runAcpPrompt({ command, args, cwd: input.worktree, env: input.env }, { prompt: input.prompt, timeoutMs: input.timeoutMs }).pipe(
      Effect.map((session) => ({
        sessionId: session.sessionId,
        transcript: session.transcript,
        exitStatus: session.exitStatus,
        durationMs: session.durationMs
      }))
    )
})

export const executeCodingSession = (
  worktreeRoot: string,
  input: CodingExecutionInput
): Effect.Effect<CodingExecutionResult, CodingAgentError> =>
  Effect.gen(function*() {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 300000) {
      return yield* new CodingAgentError({ code: "invalid", message: "Timeout is out of range" })
    }
    const adapter = yield* resolveCodingAdapter(input.agentKind, input.requestedCapabilities)
    const worktree = yield* Effect.try({
      try: () => createWorktreeSync(worktreeRoot, input.repository, input.runId),
      catch: () => new CodingAgentError({ code: "worktree", message: "Worktree creation failed" })
    })
    const startedAt = yield* Clock.currentTimeMillis
    const outcome = yield* Effect.gen(function*() {
      const session = yield* adapter.spawn({
        worktree,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        env: { ...input.tokenEnv }
      }).pipe(
        Effect.mapError((cause) => toCodingError(cause)),
        Effect.timeout(`${input.timeoutMs + 3000} millis`),
        Effect.catchTag("TimeoutError", () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.fail(
                new CodingAgentError({
                  code: "timeout",
                  message: `Coding session exceeded ${input.timeoutMs}ms`,
                  transcript: [],
                  exitStatus: undefined,
                  durationMs: now - startedAt
                })
              ))
          ))
      )
      const diffSummary = runGitSync(worktree, ["status", "--porcelain"]).slice(0, 2000) +
        "\n" +
        runGitSync(worktree, ["diff", "--stat", "HEAD"]).slice(0, 2000)
      const endedAt = yield* Clock.currentTimeMillis
      void startedAt
      return { session, diffSummary, endedAt }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          try {
            if (isManagedWorktree(worktreeRoot, worktree)) rmSync(worktree, { recursive: true, force: true })
          } catch {
            return
          }
        })
      )
    )
    const finishedAt = yield* Clock.currentTimeMillis
    void finishedAt
    const safeTranscript = boundTranscript(outcome.session.transcript)
    const safeDiff = Schema.decodeUnknownSync(Schema.String)(outcome.diffSummary.slice(0, 4000))
    return {
      sessionId: outcome.session.sessionId,
      transcript: safeTranscript,
      exitStatus: outcome.session.exitStatus,
      durationMs: outcome.session.durationMs,
      agentKind: input.agentKind,
      repository: input.repository,
      worktree,
      diffSummary: safeDiff
    }
  })

const adapters = new Map<string, CodingAgentAdapter>()

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
const toCodingError = (cause: AcpTransportError): CodingAgentError => {
  const transcript = cause.transcript === undefined ? undefined : [...cause.transcript]
  const exitStatus = cause.exitStatus
  const durationMs = cause.durationMs
  if (cause.code === "timeout") {
    return new CodingAgentError({ code: "timeout", message: cause.message, transcript, exitStatus, durationMs })
  }
  if (cause.code === "cancelled") {
    return new CodingAgentError({ code: "cancelled", message: cause.message, transcript, exitStatus, durationMs })
  }
  return new CodingAgentError({ code: "failed", message: cause.message, transcript, exitStatus, durationMs })
}

const canonicalBase = (root: string): string => {
  mkdirSync(root, { recursive: true })
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}
const isManagedWorktree = (root: string, worktree: string): boolean => {
  if (root.length === 0 || worktree.length === 0) return false
  let base = root
  let target = worktree
  try {
    base = realpathSync(root)
  } catch {
    return false
  }
  try {
    target = realpathSync(worktree)
  } catch {
    target = worktree
  }
  return target === base || target.startsWith(base + sep)
}
const createWorktreeSync = (root: string, repository: string, runId: string): string => {
  if (root.length === 0) throw new Error("Worktree root is not configured")
  const base = canonicalBase(root)
  const safeRun = runId.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 60)
  const prefix = join(base, `coding-${safeRun}-`)
  const worktree = mkdtempSync(prefix)
  if (!isManagedWorktree(base, worktree)) {
    try {
      if (isManagedWorktree(base, worktree)) rmSync(worktree, { recursive: true, force: true })
    } catch {}
    throw new Error("Worktree escaped the managed directory")
  }
  try {
    const run = (args: Array<string>): void => {
      const result = spawnSync("git", args, { cwd: worktree, stdio: "ignore" })
      if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`)
    }
    run(["init"])
    run(["config", "user.email", "automation@example.invalid"])
    run(["config", "user.name", "automation"])
    writeFileSync(join(worktree, "REPOSITORY"), `${repository}\n`, "utf-8")
    run(["add", "REPOSITORY"])
    const commit = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: worktree, stdio: "ignore" })
    if (commit.status !== 0) throw new Error("git commit failed")
    return worktree
  } catch (error) {
    try {
      if (isManagedWorktree(base, worktree)) rmSync(worktree, { recursive: true, force: true })
    } catch {
      throw error
    }
    throw error
  }
}

const runGitSync = (worktree: string, args: Array<string>): string => {
  try {
    const result = spawnSync("git", args, { cwd: worktree, encoding: "utf-8" })
    const out = typeof result.stdout === "string" ? result.stdout : ""
    return out.slice(0, 2000)
  } catch {
    return ""
  }
}
