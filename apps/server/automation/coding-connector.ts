import { Effect, Layer, Schema } from "effect"
import {
  AutomationFailure,
  CredentialReference,
  InvocationContext,
  codingActionReference,
  codingIntegrationDefinition,
  codingIntegrationReference,
  CodingAgentArguments,
  CodingAgentResult,
  CodingCapacitySelectionConfig,
  CodingRepositoryConfiguration,
  CodingSelectionResult,
  defineAction,
  defineExtension
} from "@expand/contracts/automation"
import type { InstalledAction } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { clearCodingAdapters, executeCodingSession, registerCodingAdapter } from "./coding-agent.js"
import { makeOpencodeAdapter } from "./coding-agent.js"
import {
  isCapacityAdapterRegistered,
  makeUnknownCapacityAdapter,
  registerCapacityAdapter,
  selectCodingProvider,
  selectionEvidenceLines
} from "./coding-capacity.js"

export interface CodingConnectorOptions {
  readonly worktreeRoot: string
  readonly agentCommand: string
  readonly agentArgs: ReadonlyArray<string>
  readonly defaultTimeoutMs: number
  readonly selection?: typeof CodingCapacitySelectionConfig.Type
}

export interface CodingConnectorServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
}

export const CodingCredentialSlot = "token"

export const makeCodingConnectorExtension = (options: CodingConnectorOptions, services: CodingConnectorServices) => {
  registerCodingAdapter(makeOpencodeAdapter(options.agentCommand, options.agentArgs))
  if (!isCapacityAdapterRegistered("opencode")) {
    registerCapacityAdapter(makeUnknownCapacityAdapter("opencode", ["execute", "worktree", "transcript", "diff"]))
  }
  const action = defineAction({
    definition: { ...codingActionReference },
    title: "Coding agent execute",
    integration: { ...codingIntegrationReference },
    capabilities: ["execute"],
    argumentsSchema: CodingAgentArguments,
    resultSchema: CodingAgentResult,
    integrationConfigurationSchema: CodingRepositoryConfiguration,
    handler: (
      args: typeof CodingAgentArguments.Type,
      configuration: typeof CodingRepositoryConfiguration.Type,
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
      const storedRepository = yield* Schema.decodeUnknownEffect(CodingRepositoryConfiguration, { onExcessProperty: "error" })(stored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Repository configuration is not usable" }) as AutomationFailure)
      )
      if (storedRepository.repository !== configuration.repository) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repository does not match the permitted configuration" } as AutomationFailure)
      }
      const credentials = yield* CredentialRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      const storedCredentials: unknown = stored.configuration.credentials
      const slot = typeof storedCredentials === "object" && storedCredentials !== null
        ? (storedCredentials as Record<string, unknown>)[CodingCredentialSlot]
        : undefined
      const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "Coding credential is not configured" }) as AutomationFailure)
      )
      const secret = yield* credentials.resolveSecret(context.scope, reference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (secret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "Coding credential is not configured" } as AutomationFailure)
      }
      const timeoutMs = args.timeoutMs ?? options.defaultTimeoutMs
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Timeout is out of range" } as AutomationFailure)
      }
      const requested = args.requestedCapabilities ?? ["execute"]
      for (const capability of requested) {
        if (capability !== "execute") {
          return yield* Effect.fail({ code: "invalid-contract", message: `Capability ${capability} is not granted to this action` } as AutomationFailure)
        }
      }
      const selection = args.agentKind === "auto" ? yield* selectAutoAgent(options.selection, [...requested]) : undefined
      const agentKind = selection === undefined ? args.agentKind : selection.selectedKind
      if (selection !== undefined) {
        yield* Effect.logInfo(selectionEvidenceLines(selection).join(" | "))
      }
      const outcome = yield* executeCodingSession(options.worktreeRoot, {
        runId: `${context.routineId}-${context.configurationRevision}-${context.integrationId}`,
        repository: configuration.repository,
        prompt: args.prompt,
        agentKind,
        requestedCapabilities: [...requested],
        timeoutMs,
        tokenEnv: { CODING_AGENT_TOKEN_LENGTH: String(secret.length) }
      }).pipe(
        Effect.mapError((error) => toFailure(error))
      )
      return {
        agentKind: outcome.agentKind,
        sessionId: outcome.sessionId,
        transcript: [...outcome.transcript],
        diffSummary: outcome.diffSummary,
        exitStatus: outcome.exitStatus,
        durationMs: outcome.durationMs,
        worktree: outcome.worktree,
        repository: outcome.repository,
        ...(selection === undefined
          ? {}
          : {
              selection: {
                selectedKind: selection.selectedKind,
                outcome: selection.outcome,
                evidence: selection.evidence.map((probe) => ({
                  kind: probe.kind,
                  state: probe.state,
                  detail: probe.detail
                }))
              }
            })
      }
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
    invoke: (args, configuration, context) => {
      const servicesLayer = Layer.mergeAll(
        Layer.succeed(ConfigurationRepository, services.configurations),
        Layer.succeed(CredentialRepository, services.credentials)
      )
      return action.invoke(args, configuration, context).pipe(Effect.provide(servicesLayer))
    }
  }
  return {
    action,
    extension: defineExtension({
      integrations: [codingIntegrationDefinition],
      triggers: [],
      actions: [installed],
      routines: []
    })
  }
}

export const resetCodingAdaptersForTests = (): void => {
  clearCodingAdapters()
}

const selectAutoAgent = (
  selection: typeof CodingCapacitySelectionConfig.Type | undefined,
  requested: ReadonlyArray<string>
): Effect.Effect<typeof CodingSelectionResult.Type, AutomationFailure> => {
  if (selection === undefined) {
    return Effect.fail({ code: "invalid-contract", message: "Coding provider selection is not configured" } as AutomationFailure)
  }
  return selectCodingProvider(selection, requested).pipe(
    Effect.mapError((error) => ({
      code: "connection",
      message: error.code === "invalid" ? "Coding provider selection is not configured" : "No coding provider has usable capacity",
      details: {
        evidence: (error.evidence ?? []).map((probe) => `${probe.kind}:${probe.state}:${probe.detail}`),
        outcome: "failed"
      }
    }) as AutomationFailure)
  )
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
function toFailure(error: { code: string; message: string; transcript?: ReadonlyArray<string> | undefined; exitStatus?: number | undefined; durationMs?: number | undefined }): AutomationFailure {
  const details: Record<string, string | number | Array<string>> = {}
  if (error.durationMs !== undefined) details['durationMs'] = error.durationMs
  if (error.exitStatus !== undefined) details['exitStatus'] = error.exitStatus
  if (error.transcript !== undefined) details['transcript'] = boundTranscript(error.transcript)
  return Object.keys(details).length > 0 ? { code: error.code, message: error.message, details } : { code: error.code, message: error.message }
}
