import { Data, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationFailure, CredentialReference, IntegrationConfiguration, InvocationContext
} from "@expand/contracts/automation"
import {
  SonarQubeProjectConfiguration, SonarQubeFetchArguments, SonarQubeFindingResult,
  SonarQubeVerifyArguments, SonarQubeVerifyResult,
  sonarFetchActionReference, sonarVerifyActionReference,
  sonarIntegrationDefinition, sonarIntegrationReference, sonarFindingTriggerDefinition
} from "@expand/contracts/automation/sonarqube"
import {
  defineAction, defineExtension
} from "@expand/contracts/automation"
import type { InstalledAction } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import {
  SonarTransportError, getSonarIssue, listSonarIssues, verifySonarIssue
} from "./sonar-transport.js"
import type { SonarTransportOptions } from "./sonar-transport.js"

export class SonarConnectorError extends Data.TaggedError("SonarConnectorError")<{
  readonly code: "connection" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api" | "missing-credential" | "invalid-credential" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}

export interface SonarConnectorOptions extends SonarTransportOptions {}

export interface SonarConnectorServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly http: HttpClient.HttpClient
}

export interface SonarConnectionStatus {
  readonly ok: boolean
  readonly configured: boolean
  readonly baseUrl: string
  readonly projectKey: string
  readonly issues?: number
  readonly reason?: string
  readonly code?: string
  readonly status?: number
}

export const SonarCredentialSlot = "token"

export const resolveSonarToken = Effect.fn("SonarConnector.resolveToken")(function*(
  scope: unknown,
  integration: unknown
) {
  const provedScope = yield* decodeScope(scope)
  const provedIntegration = yield* decodeIntegration(integration)
  const reference = provedIntegration.credentials[SonarCredentialSlot] as unknown
  const provedReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(reference).pipe(
    Effect.mapError(() => new SonarConnectorError({ code: "missing-credential", message: "SonarQube credential is not configured" }))
  )
  const repository = yield* CredentialRepository
  const secret = yield* repository.resolveSecret(provedScope, provedReference.credentialId).pipe(
    Effect.mapError(() => new SonarConnectorError({ code: "connection", message: "Credential resolution failed" }))
  )
  if (secret === null) {
    return yield* new SonarConnectorError({ code: "missing-credential", message: "SonarQube credential is not configured" })
  }
  return yield* decodeSecret(secret)
})

export const readSonarFinding = Effect.fn("SonarConnector.readFinding")(function*(
  scope: unknown,
  integration: unknown,
  issueKey: unknown,
  options?: SonarConnectorOptions
) {
  if (typeof issueKey !== "string" || issueKey.length === 0) {
    return yield* new SonarConnectorError({ code: "invalid-contract", message: "SonarQube issue key is not usable" })
  }
  const provedIntegration = yield* decodeIntegration(integration)
  const project = yield* decodeProject(provedIntegration.configuration)
  const token = yield* resolveSonarToken(scope, integration)
  const issue = yield* getSonarIssue(project.baseUrl, issueKey, token, { ...options, baseUrl: project.baseUrl }).pipe(
    Effect.mapError(transportError)
  )
  return yield* Schema.decodeUnknownEffect(SonarQubeFindingResult, { onExcessProperty: "error" })({
    issueKey: issue.key,
    status: issue.status,
    severity: issue.severity,
    rule: issue.rule,
    message: issue.message
  }).pipe(
    Effect.mapError(() => new SonarConnectorError({ code: "api", message: "SonarQube finding result is not usable" }))
  )
})

export const listOpenSonarFindings = Effect.fn("SonarConnector.listOpenFindings")(function*(
  scope: unknown,
  integration: unknown,
  options?: SonarConnectorOptions
) {
  const provedIntegration = yield* decodeIntegration(integration)
  const project = yield* decodeProject(provedIntegration.configuration)
  const token = yield* resolveSonarToken(scope, integration)
  return yield* listSonarIssues(project.baseUrl, project.projectKey, token, { ...options, baseUrl: project.baseUrl }).pipe(
    Effect.mapError(transportError)
  )
})

export const checkSonarConnection = (
  scope: unknown,
  integration: unknown,
  options?: SonarConnectorOptions
): Effect.Effect<SonarConnectionStatus, never, CredentialRepository | HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const provedScope = yield* decodeScope(scope).pipe(Effect.option)
    const provedIntegration = yield* decodeIntegration(integration).pipe(Effect.option)
    if (provedScope._tag === "None" || provedIntegration._tag === "None") {
      return { ok: false, configured: false, baseUrl: "", projectKey: "", reason: "Integration configuration is not usable", code: "invalid-contract" }
    }
    const scopeValue = provedScope.value
    const integrationValue = provedIntegration.value
    const project = yield* decodeProject(integrationValue.configuration).pipe(Effect.option)
    if (project._tag === "None") {
      return { ok: false, configured: false, baseUrl: "", projectKey: "", reason: "Project configuration is not usable", code: "invalid-contract" }
    }
    const projectValue = project.value
    const base: SonarConnectionStatus = { ok: false, configured: false, baseUrl: projectValue.baseUrl, projectKey: projectValue.projectKey }
    const tokenResult = yield* resolveSonarToken(scopeValue, integrationValue).pipe(
      Effect.map((value) => ({ value }) as const),
      Effect.catch((error) => Effect.succeed({ error } as const))
    )
    if ("error" in tokenResult) {
      const failure = tokenResult.error
      return {
        ...base,
        reason: failure.message,
        code: failure.code,
        ...(failure.status === undefined ? {} : { status: failure.status })
      }
    }
    const token = tokenResult.value
    const configuredBase: SonarConnectionStatus = { ...base, configured: true }
    const listed = yield* listSonarIssues(projectValue.baseUrl, projectValue.projectKey, token, options).pipe(
      Effect.map((value) => ({ value }) as const),
      Effect.catch((error) => Effect.succeed({ error } as const))
    )
    if ("error" in listed) {
      const failure = listed.error
      return {
        ...configuredBase,
        reason: failure.message,
        code: failure.code,
        ...(failure.status === undefined ? {} : { status: failure.status })
      }
    }
    return { ...configuredBase, ok: true, issues: listed.value.length }
  })

export const makeSonarConnectorExtension = (options: SonarConnectorOptions | undefined, services: SonarConnectorServices) => {
  const fetchAction = defineAction({
    definition: sonarFetchActionReference,
    title: "SonarQube fetch finding",
    integration: sonarIntegrationReference,
    capabilities: ["read"],
    argumentsSchema: SonarQubeFetchArguments,
    resultSchema: SonarQubeFindingResult,
    integrationConfigurationSchema: SonarQubeProjectConfiguration,
    handler: (
      args: typeof SonarQubeFetchArguments.Type,
      configuration: typeof SonarQubeProjectConfiguration.Type,
      context: typeof InvocationContext.Type
    ) => Effect.gen(function*() {
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
      const storedProject = yield* Schema.decodeUnknownEffect(SonarQubeProjectConfiguration, { onExcessProperty: "error" })(stored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Project configuration is not usable" }) as AutomationFailure)
      )
      if (storedProject.baseUrl !== configuration.baseUrl || storedProject.projectKey !== configuration.projectKey) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Project does not match the permitted configuration" } as AutomationFailure)
      }
      const credentials = yield* CredentialRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      const storedCredentials: unknown = stored.configuration.credentials
      const slot = typeof storedCredentials === "object" && storedCredentials !== null ? (storedCredentials as Record<string, unknown>)[SonarCredentialSlot] : undefined
      const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "SonarQube credential is not configured" }) as AutomationFailure)
      )
      const secret = yield* credentials.resolveSecret(provedContext.scope, reference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (secret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "SonarQube credential is not configured" } as AutomationFailure)
      }
      const token = yield* decodeSecret(secret).pipe(
        Effect.mapError((error) => connectorFailure(error))
      )
      const issue = yield* getSonarIssue(storedProject.baseUrl, args.issueKey, token, { ...options, baseUrl: storedProject.baseUrl }).pipe(
        Effect.mapError((error) => transportFailure(error))
      )
      return { issueKey: issue.key, status: issue.status, severity: issue.severity, rule: issue.rule, message: issue.message }
    })
  })
  const verifyAction = defineAction({
    definition: sonarVerifyActionReference,
    title: "SonarQube verify fixed",
    integration: sonarIntegrationReference,
    capabilities: ["verify"],
    argumentsSchema: SonarQubeVerifyArguments,
    resultSchema: SonarQubeVerifyResult,
    integrationConfigurationSchema: SonarQubeProjectConfiguration,
    handler: (
      args: typeof SonarQubeVerifyArguments.Type,
      configuration: typeof SonarQubeProjectConfiguration.Type,
      context: typeof InvocationContext.Type
    ) => Effect.gen(function*() {
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
      const storedProject = yield* Schema.decodeUnknownEffect(SonarQubeProjectConfiguration, { onExcessProperty: "error" })(stored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Project configuration is not usable" }) as AutomationFailure)
      )
      if (storedProject.baseUrl !== configuration.baseUrl || storedProject.projectKey !== configuration.projectKey) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Project does not match the permitted configuration" } as AutomationFailure)
      }
      const credentials = yield* CredentialRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      const storedCredentials: unknown = stored.configuration.credentials
      const slot = typeof storedCredentials === "object" && storedCredentials !== null ? (storedCredentials as Record<string, unknown>)[SonarCredentialSlot] : undefined
      const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "SonarQube credential is not configured" }) as AutomationFailure)
      )
      const secret = yield* credentials.resolveSecret(provedContext.scope, reference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (secret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "SonarQube credential is not configured" } as AutomationFailure)
      }
      const token = yield* decodeSecret(secret).pipe(
        Effect.mapError((error) => connectorFailure(error))
      )
      const verified = yield* verifySonarIssue(storedProject.baseUrl, args.issueKey, token, { ...options, baseUrl: storedProject.baseUrl }).pipe(
        Effect.mapError((error) => transportFailure(error))
      )
      if (!verified.resolved) {
        return yield* Effect.fail({
          code: "check-failed",
          message: `SonarQube finding is still open: ${verified.key}`,
          details: { issueKey: verified.key, status: verified.status, resolved: verified.resolved } as unknown as Schema.Json
        } as AutomationFailure)
      }
      return { issueKey: verified.key, resolved: verified.resolved, status: verified.status }
    })
  })
  const servicesLayer = Layer.mergeAll(
    Layer.succeed(ConfigurationRepository, services.configurations),
    Layer.succeed(CredentialRepository, services.credentials),
    Layer.succeed(HttpClient.HttpClient, services.http)
  )
  const installedFetch: InstalledAction = {
    kind: fetchAction.kind,
    definition: fetchAction.definition,
    title: fetchAction.title,
    integration: fetchAction.integration,
    capabilities: fetchAction.capabilities,
    argumentsSchema: fetchAction.argumentsSchema,
    resultSchema: fetchAction.resultSchema,
    integrationConfigurationSchema: fetchAction.integrationConfigurationSchema,
    invoke: (invokeArgs, invokeConfiguration, invokeContext) => fetchAction.invoke(invokeArgs, invokeConfiguration, invokeContext).pipe(Effect.provide(servicesLayer))
  }
  const installedVerify: InstalledAction = {
    kind: verifyAction.kind,
    definition: verifyAction.definition,
    title: verifyAction.title,
    integration: verifyAction.integration,
    capabilities: verifyAction.capabilities,
    argumentsSchema: verifyAction.argumentsSchema,
    resultSchema: verifyAction.resultSchema,
    integrationConfigurationSchema: verifyAction.integrationConfigurationSchema,
    invoke: (invokeArgs, invokeConfiguration, invokeContext) => verifyAction.invoke(invokeArgs, invokeConfiguration, invokeContext).pipe(Effect.provide(servicesLayer))
  }
  return {
    fetchAction,
    verifyAction,
    extension: defineExtension({
      integrations: [sonarIntegrationDefinition],
      triggers: [sonarFindingTriggerDefinition],
      actions: [installedFetch, installedVerify],
      routines: []
    })
  }
}

function decodeScope(scope: unknown): Effect.Effect<{ readonly ownerId: string; readonly projectId: string }, SonarConnectorError> {
  return Schema.decodeUnknownEffect(Schema.Struct({ ownerId: Schema.String.check(Schema.isMinLength(1)), projectId: Schema.String.check(Schema.isMinLength(1)) }), { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new SonarConnectorError({ code: "invalid-contract", message: "Credential scope is not usable" }))
  )
}

function decodeIntegration(integration: unknown): Effect.Effect<typeof IntegrationConfiguration.Type, SonarConnectorError> {
  return Schema.decodeUnknownEffect(IntegrationConfiguration, { onExcessProperty: "error" })(integration).pipe(
    Effect.mapError(() => new SonarConnectorError({ code: "invalid-contract", message: "Integration configuration is not usable" }))
  )
}

function decodeProject(configuration: unknown): Effect.Effect<typeof SonarQubeProjectConfiguration.Type, SonarConnectorError> {
  return Schema.decodeUnknownEffect(SonarQubeProjectConfiguration, { onExcessProperty: "error" })(configuration).pipe(
    Effect.mapError(() => new SonarConnectorError({ code: "invalid-contract", message: "Project configuration is not usable" }))
  )
}

function decodeSecret(secret: Uint8Array): Effect.Effect<string, SonarConnectorError> {
  return Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(secret),
    catch: () => new SonarConnectorError({ code: "invalid-credential", message: "SonarQube credential is not usable" })
  }).pipe(
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(new SonarConnectorError({ code: "invalid-credential", message: "SonarQube credential is not usable" }))
    )
  )
}

function transportError(error: SonarTransportError): SonarConnectorError {
  if (error.code === "auth" || error.code === "forbidden" || error.code === "not-found" || error.code === "rate-limited" || error.code === "connection" || error.code === "api" || error.code === "invalid-contract") {
    if (error.status === undefined) return new SonarConnectorError({ code: error.code, message: error.message })
    return new SonarConnectorError({ code: error.code, message: error.message, status: error.status })
  }
  return new SonarConnectorError({ code: "api", message: "SonarQube request failed" })
}

function connectorFailure(error: SonarConnectorError): AutomationFailure {
  if (error.status === undefined) return { code: error.code, message: error.message }
  return { code: error.code, message: error.message, details: { status: error.status } }
}

function transportFailure(error: SonarTransportError): AutomationFailure {
  if (error.status === undefined) return { code: error.code, message: error.message }
  return { code: error.code, message: error.message, details: { status: error.status } }
}
