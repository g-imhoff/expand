import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  codingFailure, isJsonValue, isPermittedCodingRepository, makeCodingExtension,
  resolveCodingAgent, resolveCodingDeadlineMs
} from "@expand/contracts/automation"
import type { AutomationFailure, CodingActionHandler, CodingAgentKind } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { makeCodingAdapter } from "./coding-agent.js"
import type { CodingError } from "./coding-agent.js"
import { runCodingSession } from "./coding-session.js"

export interface CodingServerOptions {
  readonly commands?: Partial<Record<CodingAgentKind, ReadonlyArray<string>>>
  readonly defaultWorktreeRoot?: string
}

export const makeCodingServerExtension = (options: CodingServerOptions) => {
  const handler: CodingActionHandler<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient> = (
    args,
    configuration,
    context
  ) => Effect.gen(function*() {
    const credentials = yield* CredentialRepository
    const configurations = yield* ConfigurationRepository
    const stored = yield* configurations.getIntegration(context.scope, context.integrationId).pipe(
      Effect.mapError((storage) => codingFailure(storage.code, "Coding integration lookup failed"))
    )
    if (stored === null) return yield* Effect.fail(codingFailure("missing-credential", "Coding integration is not configured"))
    if (!isPermittedCodingRepository(configuration, args.repository)) {
      return yield* Effect.fail(codingFailure("invalid-reference", "Repository is not permitted for this integration"))
    }
    const resolved = yield* credentials.resolveReferences(context.scope, {
      ...stored.configuration.credentials,
      ...(args.credentials ?? {})
    }).pipe(Effect.mapError((storage) => codingFailure(storage.code, "Coding credential lookup failed")))
    const env = yield* buildSessionEnv(resolved)
    const secrets: ReadonlyArray<string> = Object.values(resolved).flatMap((value): ReadonlyArray<string> =>
      typeof value === "string" && value.length > 0 ? [value] : [])
    const agent = resolveCodingAgent(configuration)
    return yield* runCodingSession({
      adapter: makeCodingAdapter(agent, commandFor(options, agent)),
      worktreeRoot: configuration.worktreeRoot ?? options.defaultWorktreeRoot ?? join(tmpdir(), "expand-coding-worktrees"),
      repository: args.repository,
      ...(args.branch === undefined ? {} : { branch: args.branch }),
      task: args.task,
      allowedActions: [...args.allowedActions],
      env,
      secrets,
      deadlineMs: resolveCodingDeadlineMs(args, configuration)
    }).pipe(Effect.mapError(toCodingFailure))
  })
  return makeCodingExtension(handler)
}

const commandFor = (options: CodingServerOptions, agent: CodingAgentKind): ReadonlyArray<string> =>
  options.commands?.[agent] ?? ["opencode", "acp"]

const buildSessionEnv = (
  resolved: Record<string, Schema.Json>
): Effect.Effect<Record<string, string>, AutomationFailure> => Effect.gen(function*() {
  const env: Record<string, string> = {}
  for (const [slot, value] of Object.entries(resolved)) {
    const name = `CODING_CREDENTIAL_${slot.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`
    if (typeof value === "string") {
      env[name] = value
      continue
    }
    env[name] = yield* Effect.try({
      try: () => Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value),
      catch: () => codingFailure("invalid-contract", "Coding credential is not encodable")
    })
  }
  return env
})

const toCodingFailure = (error: CodingError): AutomationFailure => {
  const details = isJsonValue(error.details) ? error.details : undefined
  switch (error.code) {
  case "timeout":
    return codingFailure("timeout", error.message, details)
  case "cancelled":
    return codingFailure("cancelled", error.message, details)
  case "worktree":
    return codingFailure("worktree", error.message, details)
  case "negotiation":
    return codingFailure("negotiation", error.message, details)
  case "transport":
    return codingFailure("transport", error.message, details)
  case "agent-failed":
    return codingFailure("agent-failed", error.message, details)
  case "invalid":
    return codingFailure("invalid", error.message, details)
  }
}
