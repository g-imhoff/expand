import { Data, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationFailure,
  CredentialReference,
  InvocationContext,
  LocalId,
  PersonalScope,
  CodingRepositoryConfiguration,
  defineAction,
  defineExtension
} from "@expand/contracts/automation"
import type { InstalledAction } from "@expand/contracts/automation"
import {
  PipelineRepairArguments,
  PipelineRepairConfiguration,
  PipelineRepairResult,
  PipelineWebhookEvent,
  PipelineWorkflowPayload,
  pipelineFailureTriggerDefinition,
  pipelineIntegrationDefinition,
  pipelineRepairActionReference
} from "@expand/contracts/automation/pipeline"
import { GithubRepositoryConfiguration } from "@expand/contracts/automation/github"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { getWorkflowRun, fetchWorkflowRunLogs } from "./github-transport.js"
import type { GithubConnectorOptions } from "./github-connector.js"
import { executeCodingSession, makeOpencodeAdapter, registerCodingAdapter } from "./coding-agent.js"
import { decodeSkillInputs, evaluateCompletionChecks, resolveSkill } from "./skill-registry.js"
import type { SkillDefinition } from "./skill-registry.js"

export class PipelineRepairError extends Data.TaggedError("PipelineRepairError")<{
  readonly code: "invalid-contract" | "protected-branch" | "branch-not-allowed" | "duplicate" | "retry-exhausted" | "log-fetch" | "skill" | "check-failed" | "connection" | "missing-credential"
  readonly message: string
}> {}

export interface PipelineRepairOptions {
  readonly skills: ReadonlyArray<SkillDefinition>
  readonly worktreeRoot: string
  readonly agentCommand: string
  readonly agentArgs: ReadonlyArray<string>
  readonly defaultTimeoutMs: number
  readonly githubOptions?: GithubConnectorOptions
}

export interface PipelineRepairServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly http: HttpClient.HttpClient
}

export const DefaultPipelineMaxAttempts = 2
export const DefaultPipelineProtectedBranches: ReadonlyArray<string> = ["develop", "master", "main"]

export const pipelineRepairKey = (owner: string, repo: string, runId: number): string =>
  `${owner}/${repo}#${runId}`

export const pipelineRepairKeyForScope = (scope: { readonly ownerId: string; readonly projectId: string }, owner: string, repo: string, runId: number): string =>
  `${scope.ownerId}/${scope.projectId}:${owner}/${repo}#${runId}`

export const normalizeRepairBranch = (branch: string): string => {
  const trimmed = branch.trim().toLowerCase()
  return trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed
}

export const isProtectedBranch = (branch: string, protectedBranches: ReadonlyArray<string>): boolean =>
  protectedBranches.map((entry) => normalizeRepairBranch(entry)).includes(normalizeRepairBranch(branch))

export const isBranchAllowed = (branch: string, allowedBranches: ReadonlyArray<string> | undefined): boolean => {
  if (allowedBranches === undefined) return true
  const normalized = normalizeRepairBranch(branch)
  return allowedBranches.map((entry) => normalizeRepairBranch(entry)).includes(normalized)
}

export const shouldAttemptRepair = (attempts: number, maxAttempts: number): boolean =>
  Number.isSafeInteger(attempts) && attempts >= 0 && Number.isSafeInteger(maxAttempts) && maxAttempts > 0 && attempts < maxAttempts

export const boundLogsSnippet = (text: string): string =>
  text.length <= 4000 ? text : text.slice(0, 4000)

export const resetPipelineRepairAttemptsForTests = (): void => {
  repairAttempts.clear()
}

export const repairAttemptCount = (key: string): number =>
  repairAttempts.get(key)?.attempts ?? 0

export const decodePipelineWebhookText = (raw: Uint8Array): Effect.Effect<typeof PipelineWebhookEvent.Type, PipelineRepairError> =>
  Effect.gen(function*() {
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(raw),
      catch: () => new PipelineRepairError({ code: "invalid-contract", message: "Webhook body is not usable" })
    })
    const unknownValue: unknown = yield* Schema.decodeUnknownEffect(PipelineJsonUnknown, { onExcessProperty: "ignore" })(text).pipe(
      Effect.mapError(() => new PipelineRepairError({ code: "invalid-contract", message: "Webhook body is not usable JSON" }))
    )
    const event: typeof PipelineWebhookEvent.Type = yield* Schema.decodeUnknownEffect(PipelineWebhookEvent, { onExcessProperty: "ignore" })(unknownValue).pipe(
      Effect.mapError(() => new PipelineRepairError({ code: "invalid-contract", message: "Webhook event is not a completed workflow run" }))
    )
    return event
  })

export const toPipelinePayload = (event: typeof PipelineWebhookEvent.Type): typeof PipelineWorkflowPayload.Type | null => {
  if (event.workflow_run.conclusion !== "failure") return null
  const owner = event.repository.owner.login
  const repo = event.repository.name
  const workflow = typeof event.workflow_run.name === "string" && event.workflow_run.name.length > 0
    ? event.workflow_run.name
    : "workflow"
  if (!Number.isSafeInteger(event.workflow_run.id) || event.workflow_run.id <= 0) return null
  if (owner.length === 0 || repo.length === 0) return null
  if (event.workflow_run.head_branch.length === 0 || event.workflow_run.head_sha.length === 0) return null
  if (workflow.length === 0) return null
  return {
    runId: event.workflow_run.id,
    owner,
    repo,
    branch: event.workflow_run.head_branch,
    sha: event.workflow_run.head_sha,
    workflow,
    conclusion: "failure" as const
  }
}

export const pipelineExternalId = (payload: typeof PipelineWorkflowPayload.Type): string =>
  `${payload.owner}/${payload.repo}#${payload.runId}`

export const pipelineStoredDeliveryId = (deliveryId: string, integrationId: string): string =>
  `${deliveryId}:${integrationId}`

export const makePipelineRepairExtension = (options: PipelineRepairOptions, services: PipelineRepairServices) => {
  registerCodingAdapter(makeOpencodeAdapter(options.agentCommand, options.agentArgs))
  const action = defineAction({
    definition: { ...pipelineRepairActionReference },
    title: "Pipeline repair",
    integration: { ...pipelineIntegrationDefinition.definition },
    capabilities: ["repair"],
    argumentsSchema: PipelineRepairArguments,
    resultSchema: PipelineRepairResult,
    integrationConfigurationSchema: PipelineRepairConfiguration,
    handler: (
      args: typeof PipelineRepairArguments.Type,
      configuration: typeof PipelineRepairConfiguration.Type,
      context: typeof InvocationContext.Type
    ) => Effect.gen(function*() {
      if (context.mode !== "live") {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repair runs in live mode only" } as AutomationFailure)
      }
      const maxAttempts = configuration.maxAttempts
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repair retry budget is out of range" } as AutomationFailure)
      }
      if (isProtectedBranch(args.branch, configuration.protectedBranches)) {
        return yield* Effect.fail({ code: "protected-branch", message: "Repair refuses protected branches" } as AutomationFailure)
      }
      if (!isBranchAllowed(args.branch, configuration.allowedBranches)) {
        return yield* Effect.fail({ code: "branch-not-allowed", message: "Repair branch is not permitted" } as AutomationFailure)
      }
      if (normalizeRepairBranch(args.branch).length === 0) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repair branch is not usable" } as AutomationFailure)
      }
      if (typeof args.logsSnippet === "string" && args.logsSnippet.length > 4000) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repair logs are too large" } as AutomationFailure)
      }
      const key = pipelineRepairKeyForScope(context.scope, args.owner, args.repo, args.runId)
      const configurations = yield* ConfigurationRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      const stored = yield* configurations.getIntegration(context.scope, context.integrationId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      if (stored === null) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Integration instance is not configured" } as AutomationFailure)
      }
      const storedRepair = yield* Schema.decodeUnknownEffect(PipelineRepairConfiguration, { onExcessProperty: "error" })(stored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Repair configuration is not usable" }) as AutomationFailure)
      )
      if (
        storedRepair.repairSkillId !== configuration.repairSkillId ||
        storedRepair.githubIntegrationId !== configuration.githubIntegrationId ||
        storedRepair.codingIntegrationId !== configuration.codingIntegrationId ||
        storedRepair.maxAttempts !== configuration.maxAttempts ||
        storedRepair.requireDraft !== configuration.requireDraft ||
        !sameBranchList(storedRepair.protectedBranches, configuration.protectedBranches) ||
        !sameOptionalBranchList(storedRepair.allowedBranches, configuration.allowedBranches)
      ) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repair skill does not match the permitted configuration" } as AutomationFailure)
      }
      {
        const dedupRecord = repairAttempts.get(key) ?? { attempts: 0, succeeded: false }
        if (dedupRecord.succeeded) {
          return yield* Effect.fail({ code: "duplicate", message: "Repair already completed for this workflow run" } as AutomationFailure)
        }
        if (!shouldAttemptRepair(dedupRecord.attempts, storedRepair.maxAttempts)) {
          return yield* Effect.fail({ code: "retry-exhausted", message: "Repair retry budget is exhausted" } as AutomationFailure)
        }
        repairAttempts.set(key, { attempts: dedupRecord.attempts + 1, succeeded: false })
      }
      const record = repairAttempts.get(key) ?? { attempts: 1, succeeded: false }
      const attemptNumber = record.attempts
      const skill = yield* resolveSkill(options.skills, configuration.repairSkillId).pipe(
        Effect.mapError((error) => ({ code: "invalid-contract", message: error.message }) as AutomationFailure)
      )
      const githubStored = yield* configurations.getIntegration(context.scope, configuration.githubIntegrationId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      if (githubStored === null) {
        return yield* Effect.fail({ code: "invalid-contract", message: "GitHub integration is not configured" } as AutomationFailure)
      }
      const githubRepository = yield* Schema.decodeUnknownEffect(GithubRepositoryConfiguration, { onExcessProperty: "error" })(githubStored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Repository configuration is not usable" }) as AutomationFailure)
      )
      if (githubRepository.owner !== args.owner || githubRepository.repo !== args.repo) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repository does not match the permitted configuration" } as AutomationFailure)
      }
      const credentials = yield* CredentialRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      const githubSlot: unknown = typeof githubStored.configuration.credentials === "object" && githubStored.configuration.credentials !== null
        ? (githubStored.configuration.credentials as Record<string, unknown>)["token"]
        : undefined
      const githubReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(githubSlot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "GitHub credential is not configured" }) as AutomationFailure)
      )
      const githubSecret = yield* credentials.resolveSecret(context.scope, githubReference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (githubSecret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "GitHub credential is not configured" } as AutomationFailure)
      }
      const githubToken = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(githubSecret),
        catch: () => ({ code: "missing-credential", message: "GitHub credential is not usable" }) as AutomationFailure
      }).pipe(
        Effect.flatMap((value) => value.length > 0
          ? Effect.succeed(value)
          : Effect.fail({ code: "missing-credential", message: "GitHub credential is not usable" } as AutomationFailure))
      )
      const workflowRun = yield* getWorkflowRun(args.owner, args.repo, args.runId, githubToken, options.githubOptions).pipe(
        Effect.mapError(() => ({ code: "log-fetch", message: "Workflow run lookup failed" }) as AutomationFailure)
      )
      if (workflowRun.conclusion !== null && workflowRun.conclusion !== "failure") {
        return yield* Effect.fail({ code: "invalid-contract", message: "Workflow run did not fail" } as AutomationFailure)
      }
      if (normalizeRepairBranch(workflowRun.headBranch) !== normalizeRepairBranch(args.branch)) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Workflow branch does not match the repair request" } as AutomationFailure)
      }
      if (isProtectedBranch(workflowRun.headBranch, storedRepair.protectedBranches)) {
        return yield* Effect.fail({ code: "protected-branch", message: "Repair refuses protected branches" } as AutomationFailure)
      }
      const fetchedLogs = yield* fetchWorkflowRunLogs(args.owner, args.repo, args.runId, githubToken, options.githubOptions).pipe(
        Effect.mapError(() => ({ code: "log-fetch", message: "Workflow log fetch failed" }) as AutomationFailure)
      )
      const snippet = boundLogsSnippet(fetchedLogs)
      const codingStored = yield* configurations.getIntegration(context.scope, configuration.codingIntegrationId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Configuration lookup failed" }) as AutomationFailure)
      )
      if (codingStored === null) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Coding integration is not configured" } as AutomationFailure)
      }
      const codingRepository = yield* Schema.decodeUnknownEffect(CodingRepositoryConfiguration, { onExcessProperty: "error" })(codingStored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Coding repository is not usable" }) as AutomationFailure)
      )
      if (codingRepository.repository !== `${args.owner}/${args.repo}`) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Coding repository does not match the failed pipeline" } as AutomationFailure)
      }
      const codingSlot: unknown = typeof codingStored.configuration.credentials === "object" && codingStored.configuration.credentials !== null
        ? (codingStored.configuration.credentials as Record<string, unknown>)["token"]
        : undefined
      const codingReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(codingSlot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "Coding credential is not configured" }) as AutomationFailure)
      )
      const codingSecret = yield* credentials.resolveSecret(context.scope, codingReference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (codingSecret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "Coding credential is not configured" } as AutomationFailure)
      }
      const skillInputs = yield* decodeSkillInputs(skill, {
        runId: args.runId,
        owner: args.owner,
        repo: args.repo,
        branch: args.branch,
        sha: args.sha,
        workflow: args.workflow,
        logsSnippet: snippet
      }).pipe(
        Effect.mapError((error) => ({ code: "invalid-contract", message: error.message }) as AutomationFailure)
      )
      const prompt = skill.buildPrompt(skillInputs)
      if (prompt.length === 0 || prompt.trim().length === 0) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Repair prompt is not usable" } as AutomationFailure)
      }
      const timeoutMs = options.defaultTimeoutMs
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Timeout is out of range" } as AutomationFailure)
      }
      const outcome = yield* executeCodingSession(options.worktreeRoot, {
        runId: `${context.routineId}-${context.configurationRevision}-${key}-${attemptNumber}`,
        repository: codingRepository.repository,
        prompt,
        agentKind: "opencode",
        requestedCapabilities: [...skill.requiredCapabilities],
        timeoutMs,
        tokenEnv: { CODING_AGENT_TOKEN_LENGTH: "32" }
      }).pipe(
        Effect.mapError((error) => ({ code: "skill", message: error.message }) as AutomationFailure)
      )
      const checks = evaluateCompletionChecks(skill, outcome)
      const result = {
        runId: args.runId,
        branch: args.branch,
        repaired: true,
        attempts: attemptNumber,
        skillId: skill.id,
        checks: checks.map((check) => ({ ...check })),
        ...(configuration.requireDraft
          ? { draftPr: { base: args.branch, head: `pipeline-repair/${args.runId}`, draft: true } }
          : {})
      }
      const failed = checks.filter((check) => !check.passed)
      if (failed.length > 0) {
        const names = failed.map((check) => check.check).join(",")
        return yield* Effect.fail({
          code: "check-failed",
          message: `Repair skill did not pass: ${names}`,
          details: result as unknown as Schema.Json
        } as AutomationFailure)
      }
      repairAttempts.set(key, { attempts: attemptNumber, succeeded: true })
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
        Layer.succeed(CredentialRepository, services.credentials),
        Layer.succeed(HttpClient.HttpClient, services.http)
      )
      return action.invoke(invokeArgs, invokeConfiguration, invokeContext).pipe(Effect.provide(servicesLayer))
    }
  }
  return {
    action,
    extension: defineExtension({
      integrations: [pipelineIntegrationDefinition],
      triggers: [pipelineFailureTriggerDefinition],
      actions: [installed],
      routines: []
    })
  }
}

export const pipelineContextFor = (scope: PersonalScope, routineId: string, revision: number, integrationId: string, mode: "preview" | "live") => ({
  scope: { ...scope },
  routineId,
  configurationRevision: revision,
  integrationId,
  mode
})

export const decodePipelineScope = (value: unknown): Effect.Effect<PersonalScope, PipelineRepairError> =>
  Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new PipelineRepairError({ code: "invalid-contract", message: "Scope is not usable" }))
  )

export const decodePipelineLocalId = (value: unknown): Effect.Effect<string, PipelineRepairError> =>
  Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new PipelineRepairError({ code: "invalid-contract", message: "Id is not usable" }))
  )


const sameBranchList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index])

const sameOptionalBranchList = (left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string> | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right
  return sameBranchList(left, right)
}

interface RepairRecord {
  attempts: number
  succeeded: boolean
}

const repairAttempts = new Map<string, RepairRecord>()

const PipelineJsonUnknown = Schema.fromJsonString(Schema.Unknown)
