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

export {
  makeConflictConnectorExtension
}

const ConflictCredentialSlot = "token"

const makeConflictConnectorExtension = (options: ConflictConnectorOptions, services: ConflictConnectorServices) => {
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
      return { resolved: false, reason: "resolution-unavailable:verified-repository-worktree-required" }
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
