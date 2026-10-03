import { Data, Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationFailure, CredentialReference, IntegrationConfiguration, InvocationContext, LocalId, PersonalScope
} from "@expand/contracts/automation"
import {
  GithubLabelArguments, GithubLabelResult, GithubRepositoryConfiguration,
  githubClassificationTemplate, githubIntegrationDefinition, githubIntegrationReference,
  githubLabelActionReference, githubTriggerDefinition
} from "@expand/contracts/automation/github"
import {
  defineAction, defineExtension
} from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import {
  GithubTransportError, addIssueLabels, getIssue, listIssueLabels, listRepositoryLabels
} from "./github-transport.js"
import type { GithubTransportOptions } from "./github-transport.js"

export class GithubConnectorError extends Data.TaggedError("GithubConnectorError")<{
  readonly code: "connection" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api" | "missing-credential" | "invalid-credential" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}

export interface GithubConnectorOptions extends GithubTransportOptions {}

export interface GithubConnectionStatus {
  readonly ok: boolean
  readonly configured: boolean
  readonly owner: string
  readonly repo: string
  readonly labels?: number
  readonly reason?: string
  readonly code?: string
  readonly status?: number
}

export const GithubCredentialSlot = "token"

export function unionLabels(
  existing: ReadonlyArray<string>,
  configured: ReadonlyArray<string>
): ReadonlyArray<string> {
  const seen = new Set<string>()
  const result: Array<string> = []
  for (const label of [...existing, ...configured]) {
    if (typeof label !== "string" || label.length === 0) continue
    if (seen.has(label)) continue
    seen.add(label)
    result.push(label)
  }
  return result.filter((label) => existing.includes(label) || configured.includes(label))
}

export const resolveGithubToken = Effect.fn("GithubConnector.resolveToken")(function*(
  scope: unknown,
  integration: unknown
) {
  const provedScope = yield* decodeScope(scope)
  const provedIntegration = yield* decodeIntegration(integration)
  const reference = provedIntegration.credentials[GithubCredentialSlot] as unknown
  const provedReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(reference).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "missing-credential", message: "GitHub credential is not configured" }))
  )
  const repository = yield* CredentialRepository
  const secret = yield* repository.resolveSecret(provedScope, provedReference.credentialId).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "connection", message: "Credential resolution failed" }))
  )
  if (secret === null) {
    return yield* new GithubConnectorError({ code: "missing-credential", message: "GitHub credential is not configured" })
  }
  return yield* decodeSecret(secret)
})

export const listGithubLabels = Effect.fn("GithubConnector.listLabels")(function*(
  scope: unknown,
  integration: unknown,
  options?: GithubConnectorOptions
) {
  const provedIntegration = yield* decodeIntegration(integration)
  const repository = yield* decodeRepository(provedIntegration.configuration)
  const token = yield* resolveGithubToken(scope, integration)
  return yield* listRepositoryLabels(repository.owner, repository.repo, token, options).pipe(
    Effect.mapError(transportError)
  )
})

export const readGithubIssue = Effect.fn("GithubConnector.readIssue")(function*(
  scope: unknown,
  integration: unknown,
  issueNumber: unknown,
  options?: GithubConnectorOptions
) {
  if (!Number.isSafeInteger(issueNumber) || (issueNumber as number) <= 0) {
    return yield* new GithubConnectorError({ code: "invalid-contract", message: "Issue number is out of range" })
  }
  const provedIntegration = yield* decodeIntegration(integration)
  const repository = yield* decodeRepository(provedIntegration.configuration)
  const token = yield* resolveGithubToken(scope, integration)
  return yield* getIssue(repository.owner, repository.repo, issueNumber as number, token, options).pipe(
    Effect.mapError(transportError)
  )
})

export const applyGithubLabel = Effect.fn("GithubConnector.applyLabel")(function*(
  scope: unknown,
  integration: unknown,
  issueNumber: unknown,
  label: unknown,
  options?: GithubConnectorOptions
) {
  if (!Number.isSafeInteger(issueNumber) || (issueNumber as number) <= 0) {
    return yield* new GithubConnectorError({ code: "invalid-contract", message: "Issue number is out of range" })
  }
  const provedLabel = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(label).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "Label is not usable" }))
  )
  const provedIntegration = yield* decodeIntegration(integration)
  const repository = yield* decodeRepository(provedIntegration.configuration)
  const token = yield* resolveGithubToken(scope, integration)
  const existing = yield* listIssueLabels(repository.owner, repository.repo, issueNumber as number, token, options).pipe(
    Effect.mapError(transportError)
  )
  if (existing.includes(provedLabel)) {
    return yield* Schema.decodeUnknownEffect(GithubLabelResult, { onExcessProperty: "error" })({ applied: true }).pipe(
      Effect.mapError(() => new GithubConnectorError({ code: "api", message: "Label result is not usable" }))
    )
  }
  yield* addIssueLabels(repository.owner, repository.repo, issueNumber as number, [provedLabel], token, options).pipe(
    Effect.mapError(transportError)
  )
  return yield* Schema.decodeUnknownEffect(GithubLabelResult, { onExcessProperty: "error" })({ applied: true }).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "api", message: "Label result is not usable" }))
  )
})

export const checkGithubConnection = (
  scope: unknown,
  integration: unknown,
  options?: GithubConnectorOptions
): Effect.Effect<GithubConnectionStatus, never, CredentialRepository | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const provedScope = yield* decodeScope(scope).pipe(Effect.option)
    const provedIntegration = yield* decodeIntegration(integration).pipe(Effect.option)
    if (provedScope._tag === "None" || provedIntegration._tag === "None") {
      return { ok: false, configured: false, owner: "", repo: "", reason: "Integration configuration is not usable", code: "invalid-contract" }
    }
    const scopeValue = provedScope.value
    const integrationValue = provedIntegration.value
    const repository = yield* decodeRepository(integrationValue.configuration).pipe(Effect.option)
    if (repository._tag === "None") {
      return { ok: false, configured: false, owner: "", repo: "", reason: "Repository configuration is not usable", code: "invalid-contract" }
    }
    const repoValue = repository.value
    const base: GithubConnectionStatus = { ok: false, configured: false, owner: repoValue.owner, repo: repoValue.repo }
    const token = yield* resolveGithubToken(scopeValue, integrationValue).pipe(Effect.option)
    if (token._tag === "None") {
      return { ...base, reason: "GitHub credential is not configured", code: "missing-credential" }
    }
    const configuredBase: GithubConnectionStatus = { ...base, configured: true }
    const labels = yield* listRepositoryLabels(repoValue.owner, repoValue.repo, token.value, options).pipe(
      Effect.map((value) => ({ value }) as const),
      Effect.catch((error) => Effect.succeed({ error } as const))
    )
    if ("error" in labels) {
      const failure = labels.error
      return {
        ...configuredBase,
        reason: failure.message,
        code: failure.code,
        ...(failure.status === undefined ? {} : { status: failure.status })
      }
    }
    return { ...configuredBase, ok: true, labels: labels.value.length }
  })

export const makeGithubConnectorExtension = (options?: GithubConnectorOptions) => {
  const action = defineAction({
    definition: githubLabelActionReference,
    title: "GitHub label issue",
    integration: githubIntegrationReference,
    capabilities: ["label"],
    argumentsSchema: GithubLabelArguments,
    resultSchema: GithubLabelResult,
    integrationConfigurationSchema: GithubRepositoryConfiguration,
    handler: (
      args: typeof GithubLabelArguments.Type,
      configuration: typeof GithubRepositoryConfiguration.Type,
      context: typeof InvocationContext.Type
    ) => Effect.gen(function* () {
      const provedContext = yield* Schema.decodeUnknownEffect(InvocationContext, { onExcessProperty: "error" })(context).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Invocation context is not usable" }) as AutomationFailure)
      )
      const configurations = yield* ConfigurationRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      const stored = yield* configurations.getIntegration(provedContext.scope, provedContext.integrationId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      if (stored === null) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Integration instance is not configured" } as AutomationFailure)
      }
      const storedRepository = yield* Schema.decodeUnknownEffect(GithubRepositoryConfiguration, { onExcessProperty: "error" })(stored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Repository configuration is not usable" }) as AutomationFailure)
      )
      if (storedRepository.owner !== configuration.owner || storedRepository.repo !== configuration.repo) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repository does not match the permitted configuration" } as AutomationFailure)
      }
      const credentials = yield* CredentialRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      const slot = (stored.configuration.credentials as Record<string, unknown>)[GithubCredentialSlot]
      const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "GitHub credential is not configured" }) as AutomationFailure)
      )
      const secret = yield* credentials.resolveSecret(provedContext.scope, reference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (secret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "GitHub credential is not configured" } as AutomationFailure)
      }
      const token = yield* decodeSecret(secret).pipe(
        Effect.mapError((error) => connectorFailure(error))
      )
      const existing = yield* listIssueLabels(configuration.owner, configuration.repo, args.issueNumber, token, options).pipe(
        Effect.mapError((error) => transportFailure(error))
      )
      if (existing.includes(args.label)) {
        return { applied: true }
      }
      yield* addIssueLabels(configuration.owner, configuration.repo, args.issueNumber, [args.label], token, options).pipe(
        Effect.mapError((error) => transportFailure(error))
      )
      return { applied: true }
    })
  })
  return {
    action,
    extension: defineExtension({
      integrations: [githubIntegrationDefinition],
      triggers: [githubTriggerDefinition],
      actions: [action as unknown as import("@expand/contracts/automation").InstalledAction],
      routines: [githubClassificationTemplate]
    })
  }
}

function decodeScope(scope: unknown): Effect.Effect<PersonalScope, GithubConnectorError> {
  return Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "Credential scope is not usable" }))
  )
}

function decodeIntegration(integration: unknown): Effect.Effect<IntegrationConfiguration, GithubConnectorError> {
  return Schema.decodeUnknownEffect(IntegrationConfiguration, { onExcessProperty: "error" })(integration).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "Integration configuration is not usable" }))
  )
}

function decodeRepository(configuration: unknown): Effect.Effect<typeof GithubRepositoryConfiguration.Type, GithubConnectorError> {
  return Schema.decodeUnknownEffect(GithubRepositoryConfiguration, { onExcessProperty: "error" })(configuration).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "Repository configuration is not usable" }))
  )
}

function decodeSecret(secret: Uint8Array): Effect.Effect<string, GithubConnectorError> {
  return Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(secret),
    catch: () => new GithubConnectorError({ code: "invalid-credential", message: "GitHub credential is not usable" })
  }).pipe(
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(new GithubConnectorError({ code: "invalid-credential", message: "GitHub credential is not usable" }))
    )
  )
}

function transportError(error: GithubTransportError): GithubConnectorError {
  if (error.code === "auth" || error.code === "forbidden" || error.code === "not-found" || error.code === "rate-limited" || error.code === "connection" || error.code === "api" || error.code === "invalid-contract") {
    if (error.status === undefined) return new GithubConnectorError({ code: error.code, message: error.message })
    return new GithubConnectorError({ code: error.code, message: error.message, status: error.status })
  }
  return new GithubConnectorError({ code: "api", message: "GitHub request failed" })
}

function connectorFailure(error: GithubConnectorError): AutomationFailure {
  return { code: error.code, message: error.message }
}

function transportFailure(error: GithubTransportError): AutomationFailure {
  return { code: error.code, message: error.message }
}
