import { Data, Deferred, Effect, Queue, Schema } from "effect"
import type { CodingAgentKind } from "@expand/contracts/automation"

export class CodingError extends Data.TaggedError("CodingError")<{
  readonly code: "transport" | "negotiation" | "timeout" | "cancelled" | "worktree" | "agent-failed" | "invalid"
  readonly message: string
  readonly details?: unknown
}> {}

export interface CodingAgentCapabilities {
  readonly session: boolean
  readonly prompt: boolean
  readonly cancel: boolean
}

export interface CodingProgressEvent {
  readonly sessionId: string
  readonly kind: "transcript" | "status"
  readonly text: string
  readonly at: number
}

export interface CodingAgentAdapter {
  readonly kind: CodingAgentKind
  readonly command: ReadonlyArray<string>
  readonly requiredCapabilities: ReadonlyArray<keyof CodingAgentCapabilities>
  readonly negotiate: (hello: unknown) => Effect.Effect<CodingAgentCapabilities, CodingError>
  readonly sessionRequest: (cwd: string) => unknown
  readonly sessionIdFrom: (result: unknown) => Effect.Effect<string, CodingError>
  readonly promptRequest: (sessionId: string, task: string, allowedActions: ReadonlyArray<string>) => unknown
  readonly stopReasonFrom: (result: unknown) => Effect.Effect<string, CodingError>
  readonly progressFromNotification: (method: string, params: unknown) => Omit<CodingProgressEvent, "sessionId" | "at"> | null
}

export interface CodingSessionOptions {
  readonly adapter: CodingAgentAdapter
  readonly worktreeRoot: string
  readonly repository: string
  readonly branch?: string
  readonly task: string
  readonly allowedActions: ReadonlyArray<string>
  readonly env: Record<string, string>
  readonly secrets: ReadonlyArray<string>
  readonly deadlineMs: number
  readonly progress?: Queue.Queue<CodingProgressEvent>
  readonly cancel?: Deferred.Deferred<void>
}
export interface CodingSessionResult {
  readonly sessionId: string
  readonly agent: CodingAgentKind
  readonly exitStatus: number
  readonly durationMs: number
  readonly transcript: ReadonlyArray<string>
  readonly diffSummary: string
  readonly filesChanged: ReadonlyArray<string>
}
export type CodingSessionLifecycle = "created" | "running" | "succeeded" | "failed" | "cancelled" | "timed-out"
export type CodingSessionTransition = "start" | "succeed" | "fail" | "cancel" | "timeout"
export type CodingAdapterFactory = (command: ReadonlyArray<string>) => CodingAgentAdapter
export const makeCodingAdapter = (kind: CodingAgentKind, command: ReadonlyArray<string>): CodingAgentAdapter =>
  codingAdapterFactories[kind](command)
export const nextCodingLifecycle = (state: CodingSessionLifecycle, event: CodingSessionTransition): CodingSessionLifecycle | null =>
  lifecycleTransitions[state]?.[event] ?? null
export const redactSecrets = (text: string, secrets: ReadonlyArray<string>): string => {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    redacted = redacted.split(secret).join("[redacted]")
  }
  return redacted
}
export const negotiateCapabilities = Effect.fn("CodingAgent.negotiate")(function*(
  adapter: CodingAgentAdapter,
  hello: unknown
) {
  const capabilities = yield* adapter.negotiate(hello)
  for (const required of adapter.requiredCapabilities) {
    if (!capabilities[required]) {
      return yield* new CodingError({ code: "negotiation", message: `Agent ${adapter.kind} does not support ${required}` })
    }
  }
  return capabilities
})

const codingAdapterFactories: Record<CodingAgentKind, CodingAdapterFactory> = {
  opencode: (command) => makeAcpAdapter("opencode", command),
  stub: (command) => makeAcpAdapter("stub", command)
}
const lifecycleTransitions: Record<CodingSessionLifecycle, Partial<Record<CodingSessionTransition, CodingSessionLifecycle>>> = {
  created: { start: "running", cancel: "cancelled" },
  running: { succeed: "succeeded", fail: "failed", cancel: "cancelled", timeout: "timed-out" },
  succeeded: {},
  failed: {},
  cancelled: {},
  "timed-out": {}
}
const HelloSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  agentCapabilities: Schema.Unknown,
  agentInfo: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) }))
})
const SessionSchema = Schema.Struct({ sessionId: Schema.String.check(Schema.isMinLength(1)) })
const StopSchema = Schema.Union([
  Schema.Struct({ stopReason: Schema.String.check(Schema.isMinLength(1)) }),
  Schema.String.check(Schema.isMinLength(1))
])
const makeAcpAdapter = (kind: CodingAgentKind, command: ReadonlyArray<string>): CodingAgentAdapter => ({
  kind,
  command,
  requiredCapabilities: ["session", "prompt"],
  negotiate: Effect.fn(`${kind}.negotiate`)(function*(hello: unknown) {
    const parsed = yield* Schema.decodeUnknownEffect(HelloSchema)(hello).pipe(
      Effect.mapError(() => new CodingError({ code: "negotiation", message: `Agent ${kind} sent an unusable hello` }))
    )
    if (parsed.protocolVersion !== 1 || parsed.agentCapabilities === null || typeof parsed.agentCapabilities !== "object") {
      return yield* new CodingError({ code: "negotiation", message: `Agent ${kind} speaks an unsupported protocol version` })
    }
    return { session: true, prompt: true, cancel: true }
  }),
  sessionRequest: (cwd: string) => ({ cwd, mcpServers: [] }),
  sessionIdFrom: Effect.fn(`${kind}.sessionId`)(function*(result: unknown) {
    const parsed = yield* Schema.decodeUnknownEffect(SessionSchema)(result).pipe(
      Effect.mapError(() => new CodingError({ code: "transport", message: `Agent ${kind} returned an unusable session` }))
    )
    return parsed.sessionId
  }),
  promptRequest: (sessionId: string, task: string, allowedActions: ReadonlyArray<string>) => ({
    sessionId,
    prompt: [
      { type: "text", text: task },
      { type: "text", text: `Allowed actions: ${allowedActions.join(",")}. Stay inside the session worktree.` }
    ]
  }),
  stopReasonFrom: Effect.fn(`${kind}.stopReason`)(function*(result: unknown) {
    const parsed = yield* Schema.decodeUnknownEffect(StopSchema)(result).pipe(
      Effect.mapError(() => new CodingError({ code: "agent-failed", message: `Agent ${kind} returned an unusable prompt result` }))
    )
    return typeof parsed === "string" ? parsed : parsed.stopReason
  }),
  progressFromNotification: (method: string, params: unknown) => {
    if (method !== "session/update") return null
    const update = typeof params === "object" && params !== null && !Array.isArray(params) &&
      "update" in params ? (params as { readonly update?: unknown }).update : undefined
    const texts = collectNotificationText(update)
    if (texts.length === 0) return null
    return { kind: "transcript", text: texts.join("\n").slice(0, 4000) }
  }
})

const collectNotificationText = (params: unknown): ReadonlyArray<string> => {
  if (typeof params === "string") return params.length === 0 ? [] : [params]
  if (params === null || typeof params !== "object") return []
  if (Array.isArray(params)) return params.flatMap(collectNotificationText)
  const texts: Array<string> = []
  for (const value of Object.values(params)) {
    if (typeof value === "string" && value.length > 0 && value.length <= 4000) texts.push(value)
    else if (value !== null && typeof value === "object") texts.push(...collectNotificationText(value))
  }
  return texts.filter((text) => text !== "session/update").slice(0, 8)
}
