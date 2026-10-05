import { Effect, Layer, Schema } from "effect"
import {
  AutomationFailure,
  CredentialReference,
  InvocationContext,
  codingIntegrationDefinition,
  codingIntegrationReference,
  CodingRepositoryConfiguration,
  defineAction,
  defineExtension
} from "@expand/contracts/automation"
import {
  SkillExecuteArguments,
  SkillExecuteResult,
  skillActionReference
} from "@expand/contracts/automation/skills"
import type { InstalledAction } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { executeCodingSession, makeOpencodeAdapter, registerCodingAdapter, resolveCodingAdapter } from "./coding-agent.js"
import { decodeSkillInputs, evaluateCompletionChecks, resolveSkill } from "./skill-registry.js"
import type { SkillDefinition } from "./skill-registry.js"

export interface SkillConnectorOptions {
  readonly worktreeRoot: string
  readonly agentCommand: string
  readonly agentArgs: ReadonlyArray<string>
  readonly defaultTimeoutMs: number
  readonly skills: ReadonlyArray<SkillDefinition>
}

export interface SkillConnectorServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
}

export const SkillCredentialSlot = "token"

export const makeSkillConnectorExtension = (options: SkillConnectorOptions, services: SkillConnectorServices) => {
  registerCodingAdapter(makeOpencodeAdapter(options.agentCommand, options.agentArgs))
  const action = defineAction({
    definition: { ...skillActionReference },
    title: "Coding skill execute",
    integration: { ...codingIntegrationReference },
    capabilities: ["execute"],
    argumentsSchema: SkillExecuteArguments,
    resultSchema: SkillExecuteResult,
    integrationConfigurationSchema: CodingRepositoryConfiguration,
    handler: (
      args: typeof SkillExecuteArguments.Type,
      configuration: typeof CodingRepositoryConfiguration.Type,
      context: typeof InvocationContext.Type
    ) => Effect.gen(function*() {
      const skill = yield* resolveSkill(options.skills, args.skillId).pipe(
        Effect.mapError((error) => ({ code: "invalid-contract", message: error.message }) as AutomationFailure)
      )
      const inputs = yield* decodeSkillInputs(skill, args.inputs).pipe(
        Effect.mapError((error) => ({ code: "invalid-contract", message: error.message }) as AutomationFailure)
      )
      for (const capability of skill.requiredCapabilities) {
        if (capability !== "execute") {
          return yield* Effect.fail({ code: "invalid-contract", message: `Capability ${capability} is not granted to this action` } as AutomationFailure)
        }
      }
      const timeoutMs = args.timeoutMs ?? options.defaultTimeoutMs
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Timeout is out of range" } as AutomationFailure)
      }
      const agentKind = args.agentKind ?? "opencode"
      if (agentKind.length === 0 || agentKind.trim().length === 0) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Agent kind is not usable" } as AutomationFailure)
      }
      yield* resolveCodingAdapter(agentKind, [...skill.requiredCapabilities]).pipe(
        Effect.mapError((error) => ({ code: "invalid-contract", message: error.message }) as AutomationFailure)
      )
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
        ? (storedCredentials as Record<string, unknown>)[SkillCredentialSlot]
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
      const prompt = skill.buildPrompt(inputs)
      if (prompt.length === 0 || prompt.trim().length === 0) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Skill prompt is not usable" } as AutomationFailure)
      }
      const outcome = yield* executeCodingSession(options.worktreeRoot, {
        runId: `${context.routineId}-${context.configurationRevision}-${context.integrationId}-${skill.id}`,
        repository: configuration.repository,
        prompt,
        agentKind,
        requestedCapabilities: [...skill.requiredCapabilities],
        timeoutMs,
        tokenEnv: { CODING_AGENT_TOKEN_LENGTH: String(Math.max(32, Math.ceil(secret.length / 32) * 32)) }
      }).pipe(
        Effect.mapError((error) => toFailure(error))
      )
      const checks = evaluateCompletionChecks(skill, outcome)
      const result = {
        skillId: skill.id,
        agentKind: outcome.agentKind,
        sessionId: outcome.sessionId,
        transcript: [...outcome.transcript],
        diffSummary: outcome.diffSummary,
        exitStatus: outcome.exitStatus,
        durationMs: outcome.durationMs,
        worktree: outcome.worktree,
        repository: outcome.repository,
        checks: checks.map((check) => ({ ...check }))
      }
      const failed = checks.filter((check) => !check.passed)
      if (failed.length > 0) {
        const names = failed.map((check) => check.check).join(",")
        return yield* Effect.fail({
          code: "check-failed",
          message: `Skill ${skill.id} did not pass: ${names}`,
          details: result as unknown as Schema.Json
        } as AutomationFailure)
      }
      return result
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
        Layer.succeed(CredentialRepository, services.credentials)
      )
      return action.invoke(invokeArgs, invokeConfiguration, invokeContext).pipe(Effect.provide(servicesLayer))
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
  if (error.durationMs !== undefined) details["durationMs"] = error.durationMs
  if (error.exitStatus !== undefined) details["exitStatus"] = error.exitStatus
  if (error.transcript !== undefined) details["transcript"] = boundTranscript(error.transcript)
  return Object.keys(details).length > 0 ? { code: error.code, message: error.message, details: details as unknown as Schema.Json } : { code: error.code, message: error.message }
}
