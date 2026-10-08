import { Clock, Effect, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationError,
  EmailMessagePayload,
  InvocationAuthority,
  JevDecisionRequest,
  JevDecisionResult,
  decodeJson,
  sameDefinition
} from "@expand/contracts/automation"
import type {
  AutomationFailure,
  RoutineConfiguration
} from "@expand/contracts/automation"
import {
  GmailOrganizeResult,
  emailOrganizeActionReference,
  validateGmailClassificationInput
} from "@expand/contracts/automation/gmail"
import { AutomationRegistry } from "./registry.js"
import type { JevClassifyOptions, JevDecisionError } from "./jev-client.js"
export interface EmailInput {
  readonly messageId: string
  readonly threadId: string
  readonly from: string
  readonly subject: string
  readonly body: string
}
export interface EmailDecideInput {
  readonly request: typeof JevDecisionRequest.Type
  readonly descriptions: Record<string, string>
  readonly options?: JevClassifyOptions
}
export interface EmailRunInput {
  readonly configuration: RoutineConfiguration
  readonly email: EmailInput
  readonly mode: "preview" | "live"
  readonly decide: EmailDecide
  readonly registry: AutomationRegistry
  readonly authority?: InvocationAuthority
  readonly jevOptions?: JevClassifyOptions
}
export interface EmailClassifiedOutcome {
  readonly kind: "classified"
  readonly request: typeof JevDecisionRequest.Type
  readonly decision: typeof JevDecisionResult.Type
  readonly latencyMs: number
  readonly outcomeId: string
  readonly label: string
  readonly moveTo: string
  readonly actions: ReadonlyArray<{ readonly stepId: string; readonly arguments: Schema.Json }>
  readonly executed: boolean
  readonly results: ReadonlyArray<{ readonly stepId: string; readonly applied: boolean; readonly moved: boolean }>
}
export interface EmailUnresolvedOutcome {
  readonly kind: "unresolved"
  readonly request: typeof JevDecisionRequest.Type
  readonly decision: typeof JevDecisionResult.Type
  readonly latencyMs: number
  readonly reason: string
  readonly executed: false
}
export interface EmailFailedOutcome {
  readonly kind: "failed"
  readonly request: typeof JevDecisionRequest.Type
  readonly error: AutomationFailure
  readonly latencyMs: number
  readonly executed: boolean
}

export {
  type EmailDecide,
  buildEmailClassificationRequest,
  runEmailClassification
}

type EmailDecide = (input: EmailDecideInput) => Effect.Effect<typeof JevDecisionResult.Type, JevDecisionError, HttpClient.HttpClient>

const buildEmailClassificationRequest = Effect.fn("EmailClassification.build")(function*(
  input: { readonly configuration: RoutineConfiguration; readonly email: EmailInput; readonly inputId?: string }
) {
  const validated = yield* validateGmailClassificationInput({
    configuration: input.configuration.configuration,
    integrations: input.configuration.integrations,
    process: input.configuration.process
  })
  const triggerPayload = yield* decodeJson(EmailMessagePayload, {
    messageId: input.email.messageId,
    threadId: input.email.threadId
  })
  const descriptions: Record<string, string> = {}
  for (const category of validated.classification.categories) {
    const label = validated.classification.labels[category]
    if (label === undefined) {
      return yield* new AutomationError({ code: "invalid-reference", message: "Missing label mapping" })
    }
    descriptions[category] = label
  }
  const request = yield* decodeJson(JevDecisionRequest, {
    schemaVersion: 1,
    kind: "jev-request",
    provider: "opencode-zen",
    model: "jev",
    version: "1.13",
    configuration: input.configuration.reference,
    input: { kind: "input-reference", id: input.inputId ?? input.email.messageId },
    outcomes: [...validated.classification.categories],
    data: {
      messageId: input.email.messageId,
      threadId: input.email.threadId,
      from: input.email.from,
      subject: input.email.subject,
      body: input.email.body
    }
  })
  return { classification: validated.classification, process: validated.process, request, descriptions, triggerPayload }
})

const toEmailClassificationFailure = (error: JevDecisionError): AutomationFailure => ({
  code: error.code,
  message: error.message
})
const buildEmailClassificationAuthority = Effect.fn("EmailClassification.authority")(function*(
  configuration: RoutineConfiguration,
  registry: AutomationRegistry
) {
  const validated = yield* validateGmailClassificationInput({
    configuration: configuration.configuration,
    integrations: configuration.integrations,
    process: configuration.process
  })
  const steps = Object.values(validated.process.actions).flat()
  const catalog = registry.catalog()
  const actionGrants: Array<{ readonly action: (typeof steps)[number]["action"]; readonly integrationId: string; readonly capabilities: ReadonlyArray<string> }> = []
  for (const step of steps) {
    const entry = catalog.definitions.find(
      (candidate) => candidate.kind === "action" && candidate.definition.id === step.action.id
    )
    if (entry === undefined || entry.kind !== "action") {
      return yield* new AutomationError({ code: "missing-definition", message: "Missing action definition for authority grant" })
    }
    actionGrants.push({ action: step.action, integrationId: step.integration.id, capabilities: [...entry.capabilities] })
  }
  return yield* decodeJson(InvocationAuthority, {
    schemaVersion: 1,
    kind: "invocation-authority",
    scope: configuration.scope,
    configuration: configuration.reference,
    integrationIds: configuration.integrations.map((integration) => integration.id),
    actionGrants
  })
})
const runEmailClassification = Effect.fn("EmailClassification.run")(function*(
  input: EmailRunInput
) {
  const built = yield* buildEmailClassificationRequest({ configuration: input.configuration, email: input.email })
  const started = yield* Clock.currentTimeMillis
  const settled = yield* Effect.result(
    input.decide({
      request: built.request,
      descriptions: built.descriptions,
      ...(input.jevOptions === undefined ? {} : { options: input.jevOptions })
    })
  )
  const finished = yield* Clock.currentTimeMillis
  const latencyMs = finished - started
  if (Result.isFailure(settled)) {
    const outcome: EmailFailedOutcome = {
      kind: "failed",
      request: built.request,
      error: toEmailClassificationFailure(settled.failure),
      latencyMs,
      executed: false
    }
    return outcome
  }
  const decision = settled.success
  if (decision.kind === "abstained") {
    const resolved = yield* input.registry.resolveSelectedActions(input.configuration, built.triggerPayload, decision)
    if (resolved.selection.kind !== "unresolved") {
      return yield* new AutomationError({ code: "invalid-reference", message: "Abstention must leave the input unchanged" })
    }
    const outcome: EmailUnresolvedOutcome = {
      kind: "unresolved",
      request: built.request,
      decision,
      latencyMs,
      reason: resolved.selection.reason,
      executed: false
    }
    return outcome
  }
  if (!built.classification.categories.includes(decision.outcomeId)) {
    return yield* new AutomationError({ code: "invalid-reference", message: "Decision selected an unknown outcome" })
  }
  const label = built.classification.labels[decision.outcomeId]
  const moveTo = built.classification.moves[decision.outcomeId]
  if (label === undefined) {
    return yield* new AutomationError({ code: "invalid-reference", message: "Missing label mapping" })
  }
  if (moveTo === undefined) {
    return yield* new AutomationError({ code: "invalid-reference", message: "Missing folder mapping" })
  }
  const resolved = yield* input.registry.resolveSelectedActions(input.configuration, built.triggerPayload, decision)
  if (resolved.selection.kind !== "selected" || resolved.selection.outcomeId !== decision.outcomeId) {
    return yield* new AutomationError({ code: "invalid-reference", message: "Decision does not match a configured route" })
  }
  if (resolved.actions.length === 0) {
    return yield* new AutomationError({ code: "invalid-reference", message: "Every category needs at least one organize action" })
  }
  for (const action of resolved.actions) {
    if (!sameDefinition(action.action, emailOrganizeActionReference)) {
      return yield* new AutomationError({ code: "invalid-reference", message: "Only the email organize action is allowed" })
    }
    const args = action.arguments as unknown as Record<string, unknown>
    if (args["label"] !== label) {
      return yield* new AutomationError({ code: "invalid-reference", message: "Literal labels must use the mapped category label" })
    }
    if (args["moveTo"] !== moveTo) {
      return yield* new AutomationError({ code: "invalid-reference", message: "Literal destinations must use the mapped category folder" })
    }
  }
  if (input.mode === "preview") {
    const outcome: EmailClassifiedOutcome = {
      kind: "classified",
      request: built.request,
      decision,
      latencyMs,
      outcomeId: decision.outcomeId,
      label,
      moveTo,
      actions: resolved.actions.map((action) => ({ stepId: action.stepId, arguments: action.arguments })),
      executed: false,
      results: []
    }
    return outcome
  }
  const authority = input.authority ?? (yield* buildEmailClassificationAuthority(input.configuration, input.registry))
  const results: Array<{ readonly stepId: string; readonly applied: boolean; readonly moved: boolean }> = []
  for (const action of resolved.actions) {
    const invoked = yield* input.registry.invokeAction(
      {
        configuration: input.configuration,
        stepId: action.stepId,
        triggerPayload: built.triggerPayload,
        decision,
        mode: "live"
      },
      authority
    ).pipe(
      Effect.mapError((registryError) =>
        new AutomationError({
          code: registryError.code,
          message: registryError.message,
          ...(registryError.failure === undefined ? {} : { failure: registryError.failure })
        })
      )
    )
    const parsed = yield* decodeJson(GmailOrganizeResult, invoked).pipe(
      Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: "Organize result does not match its contract" }))
    )
    results.push({ stepId: action.stepId, applied: parsed.applied, moved: parsed.moved })
  }
  const outcome: EmailClassifiedOutcome = {
    kind: "classified",
    request: built.request,
    decision,
    latencyMs,
    outcomeId: decision.outcomeId,
    label,
    moveTo,
    actions: resolved.actions.map((action) => ({ stepId: action.stepId, arguments: action.arguments })),
    executed: true,
    results
  }
  return outcome
})
