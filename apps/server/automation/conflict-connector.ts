import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationFailure,
  CredentialReference,
  InvocationContext,
  conflictIntegrationDefinition,
  conflictIntegrationReference,
  prConflictTriggerDefinition,
  GithubPrConflictConfiguration,
  GithubPrResolveArguments,
  GithubPrResolveResult,
  prResolveActionReference,
  defineAction,
  defineExtension
} from "@expand/contracts/automation"
import type { InstalledAction } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { executeCodingSession, makeOpencodeAdapter, registerCodingAdapter } from "./coding-agent.js"
import { getPullRequest } from "./github-pr-transport.js"
import type { GithubPrTransportOptions } from "./github-pr-transport.js"
import { classifyMergeability, isPermittedBranch, isProtectedBranch } from "./pr-conflict-policy.js"

export interface ConflictConnectorOptions {
  readonly worktreeRoot: string
  readonly agentCommand: string
  readonly agentArgs: ReadonlyArray<string>
  readonly defaultTimeoutMs: number
  readonly githubOptions?: GithubPrTransportOptions
}

export interface ConflictConnectorServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly http: HttpClient.HttpClient
}

export const ConflictCredentialSlot = "token"

export const buildConflictPrompt = (input: { readonly pullNumber: number; readonly headBranch: string; readonly baseBranch: string }): string => {
  const head = input.headBranch.trim().slice(0, 120)
  const base = input.baseBranch.trim().slice(0, 120)
  if (head.length === 0 || base.length === 0) return ""
  return [
    `You are resolving a GitHub PR merge conflict in an isolated worktree.`,
    `Merge origin/${base} into ${head} and resolve only real merge conflicts.`,
    `PR: ${input.pullNumber} head:${head} base:${base}`,
    `Only modify files that Git reports as conflicted. Do not reformat unrelated files.`,
    `write:RESOLUTION.md:resolved ${head} pr ${input.pullNumber}`,
    `When done, report resolved ${head}.`
  ].join("\n")
}

export const evaluateResolutionChecks = (input: { readonly diffSummary: string; readonly transcript: ReadonlyArray<string>; readonly exitStatus: number; readonly headBranch: string }): { readonly passed: boolean; readonly reason: string } => {
  if (input.exitStatus !== 0) return { passed: false, reason: "check-failed:agent-exit" }
  if (input.diffSummary.trim().length === 0) return { passed: false, reason: "check-failed:empty-diff" }
  const transcript = [...input.transcript].join("\n")
  if (!transcript.includes(`resolved ${input.headBranch}`) && !transcript.includes("wrote RESOLUTION.md")) return { passed: false, reason: "check-failed:missing-resolution-marker" }
  return { passed: true, reason: "ok" }
}

export const checkPrConflicts = Effect.fn("ConflictConnector.checkConflicts")(function*(
  owner: string,
  repo: string,
  token: string,
  policy: { readonly permittedBranches: ReadonlyArray<string>; readonly protectedBranches: ReadonlyArray<string>; readonly defaultBranch: string },
  options?: GithubPrTransportOptions
) {
  const { listOpenPulls } = yield* Effect.promise(() => import("./github-pr-transport.js"))
  const pulls = yield* listOpenPulls(owner, repo, token, options)
  const bounded = pulls.slice(0, 20)
  const out: Array<{ readonly pullNumber: number; readonly headBranch: string; readonly baseBranch: string; readonly headSha: string; readonly mergeable: boolean }> = []
  for (const pull of bounded) {
    const fresh = yield* getPullRequest(owner, repo, pull.number, token, options)
    const state = classifyMergeability({ mergeable: fresh.mergeable, mergeableState: fresh.mergeableState })
    if (state !== "conflicted") continue
    const permitted = isPermittedBranch(fresh.headBranch, policy)
    const protectedHead = isProtectedBranch(fresh.headBranch, policy.protectedBranches, policy.defaultBranch)
    if (!permitted || protectedHead) continue
    out.push({ pullNumber: fresh.number, headBranch: fresh.headBranch, baseBranch: fresh.baseBranch, headSha: fresh.headSha, mergeable: false })
    if (out.length >= 20) break
  }
  return out
})

export const makeConflictConnectorExtension = (options: ConflictConnectorOptions, services: ConflictConnectorServices) => {
  registerCodingAdapter(makeOpencodeAdapter(options.agentCommand, options.agentArgs))
  const action = defineAction({
    definition: { ...prResolveActionReference },
    title: "GitHub resolve PR conflict",
    integration: { ...conflictIntegrationReference },
    capabilities: ["resolve"],
    argumentsSchema: GithubPrResolveArguments,
    resultSchema: GithubPrResolveResult,
    integrationConfigurationSchema: GithubPrConflictConfiguration,
    handler: (
      args: typeof GithubPrResolveArguments.Type,
      configuration: typeof GithubPrConflictConfiguration.Type,
      context: typeof InvocationContext.Type
    ) => Effect.gen(function*() {
      const configurations = yield* ConfigurationRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      const stored = yield* configurations.getIntegration(context.scope, context.integrationId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      if (stored === null) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Integration instance is not configured" } as AutomationFailure)
      }
      const storedConfig = yield* Schema.decodeUnknownEffect(GithubPrConflictConfiguration, { onExcessProperty: "error" })(stored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Conflict configuration is not usable" }) as AutomationFailure)
      )
      if (storedConfig.owner !== configuration.owner || storedConfig.repo !== configuration.repo) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repository does not match the permitted configuration" } as AutomationFailure)
      }
      const policy = { permittedBranches: [...storedConfig.permittedBranches], protectedBranches: [...storedConfig.protectedBranches], defaultBranch: storedConfig.defaultBranch }
      if (isProtectedBranch(args.headBranch, policy.protectedBranches, policy.defaultBranch)) {
        return yield* Effect.fail({ code: "check-failed", message: "protected-branch:head is protected", details: { resolved: false, reason: "protected-branch" } as unknown as Schema.Json } as AutomationFailure)
      }
      if (args.headBranch === policy.defaultBranch) {
        return yield* Effect.fail({ code: "check-failed", message: "default-branch:head is default", details: { resolved: false, reason: "default-branch" } as unknown as Schema.Json } as AutomationFailure)
      }
      if (!isPermittedBranch(args.headBranch, policy)) {
        return yield* Effect.fail({ code: "check-failed", message: "unvalidated:head is not permitted", details: { resolved: false, reason: "unvalidated" } as unknown as Schema.Json } as AutomationFailure)
      }
      const credentials = yield* CredentialRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      const storedCredentials: unknown = stored.configuration.credentials
      const slot = typeof storedCredentials === "object" && storedCredentials !== null ? (storedCredentials as Record<string, unknown>)[ConflictCredentialSlot] : undefined
      const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "GitHub credential is not configured" }) as AutomationFailure)
      )
      const secret = yield* credentials.resolveSecret(context.scope, reference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (secret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "GitHub credential is not configured" } as AutomationFailure)
      }
      const token = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(secret),
        catch: () => ({ code: "invalid-contract", message: "GitHub credential is not usable" }) as AutomationFailure
      }).pipe(
        Effect.flatMap((value) => value.length > 0 ? Effect.succeed(value) : Effect.fail({ code: "invalid-contract", message: "GitHub credential is not usable" } as AutomationFailure))
      )
      const fresh = yield* getPullRequest(configuration.owner, configuration.repo, args.pullNumber, token, options.githubOptions).pipe(
        Effect.mapError((error) => ({ code: error.code, message: error.message }) as AutomationFailure)
      )
      if (fresh.headSha !== args.expectedHeadSha) {
        return yield* Effect.fail({ code: "check-failed", message: "unvalidated:head moved", details: { resolved: false, reason: "unvalidated" } as unknown as Schema.Json } as AutomationFailure)
      }
      if (fresh.headBranch !== args.headBranch || fresh.baseBranch !== args.baseBranch) {
        return yield* Effect.fail({ code: "check-failed", message: "unvalidated:branches moved", details: { resolved: false, reason: "unvalidated" } as unknown as Schema.Json } as AutomationFailure)
      }
      const state = classifyMergeability({ mergeable: fresh.mergeable, mergeableState: fresh.mergeableState })
      if (state !== "conflicted") {
        return { resolved: false, reason: "not-conflicted" }
      }
      const timeoutMs = options.defaultTimeoutMs
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Timeout is out of range" } as AutomationFailure)
      }
      const prompt = buildConflictPrompt({ pullNumber: args.pullNumber, headBranch: args.headBranch, baseBranch: args.baseBranch })
      if (prompt.length === 0) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Conflict prompt is not usable" } as AutomationFailure)
      }
      const outcome = yield* executeCodingSession(options.worktreeRoot, {
        runId: `${context.routineId}-${context.configurationRevision}-${context.integrationId}-${args.pullNumber}`,
        repository: `${configuration.owner}/${configuration.repo}`,
        prompt,
        agentKind: "opencode",
        requestedCapabilities: ["execute"],
        timeoutMs,
        tokenEnv: { CODING_AGENT_TOKEN_LENGTH: String(Math.max(32, Math.ceil(secret.length / 32) * 32)) }
      }).pipe(
        Effect.mapError((error) => ({ code: error.code, message: error.message, details: { transcript: error.transcript ?? [], exitStatus: error.exitStatus ?? -1 } } as unknown as AutomationFailure))
      )
      const checks = evaluateResolutionChecks({ diffSummary: outcome.diffSummary, transcript: [...outcome.transcript], exitStatus: outcome.exitStatus, headBranch: args.headBranch })
      if (!checks.passed) {
        return yield* Effect.fail({ code: "check-failed", message: checks.reason, details: { resolved: false, reason: "check-failed" } as unknown as Schema.Json } as AutomationFailure)
      }
      return { resolved: true, headSha: fresh.headSha, reason: "resolved-in-worktree" }
    })
  })
  const installed: InstalledAction = {
    kind: action.kind,
    definition: action.definition,
    title: action.title,
    integration: action.integration,
    capabilities: action.capabilities,
    argumentsSchema: action.argumentsSchema,
    resultSchema: action.resultSchema,
    integrationConfigurationSchema: action.integrationConfigurationSchema,
    invoke: (invokeArgs, invokeConfiguration, invokeContext) => {
      const servicesLayer = Layer.mergeAll(
        Layer.succeed(ConfigurationRepository, services.configurations),
        Layer.succeed(CredentialRepository, services.credentials),
        Layer.succeed(HttpClient.HttpClient, services.http)
      )
      return action.invoke(invokeArgs, invokeConfiguration, invokeContext).pipe(Effect.provide(servicesLayer))
    }
  }
  return {
    action,
    extension: defineExtension({
      integrations: [conflictIntegrationDefinition],
      triggers: [prConflictTriggerDefinition],
      actions: [installed],
      routines: []
    })
  }
}
