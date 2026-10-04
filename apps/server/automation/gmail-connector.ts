import { Clock, Data, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import {
  AutomationFailure, CredentialReference, IntegrationConfiguration, InvocationContext, LocalId, PersonalScope
} from "@expand/contracts/automation"
import {
  GmailMailboxConfiguration, GmailOrganizeArguments, GmailOrganizeResult,
  emailOrganizeActionReference, gmailClassificationTemplate, gmailIntegrationDefinition, gmailIntegrationReference, emailTriggerDefinition
} from "@expand/contracts/automation/gmail"
import {
  defineAction, defineExtension
} from "@expand/contracts/automation"
import type { InstalledAction } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import {
  GmailTransportError, getMessage, listHistory, listMessages, modifyMessage
} from "./gmail-transport.js"
import type { GmailMessage, GmailTransportOptions } from "./gmail-transport.js"
export class GmailConnectorError extends Data.TaggedError("GmailConnectorError")<{
  readonly code: "connection" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api" | "missing-credential" | "invalid-credential" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}
export interface GmailConnectorOptions extends GmailTransportOptions {}
export interface GmailConnectorServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly http: HttpClient.HttpClient
  readonly sql: SqlClient
}
export interface GmailConnectionStatus {
  readonly ok: boolean
  readonly configured: boolean
  readonly mailbox: string
  readonly messages?: number
  readonly reason?: string
  readonly code?: string
  readonly status?: number
}
export interface GmailPollResult {
  readonly historyId: string
  readonly fresh: ReadonlyArray<GmailMessage>
  readonly skippedSeen: number
  readonly skippedSent: number
}
export const GmailCredentialSlot = "oauth"
export function unionLabelIds(
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
  return result
}
export const resolveGmailToken = Effect.fn("GmailConnector.resolveToken")(function*(
  scope: unknown,
  integration: unknown
) {
  const provedScope = yield* decodeScope(scope)
  const provedIntegration = yield* decodeIntegration(integration)
  const reference = provedIntegration.credentials[GmailCredentialSlot] as unknown
  const provedReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(reference).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "missing-credential", message: "Gmail credential is not configured" }))
  )
  const repository = yield* CredentialRepository
  const secret = yield* repository.resolveSecret(provedScope, provedReference.credentialId).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "connection", message: "Credential resolution failed" }))
  )
  if (secret === null) {
    return yield* new GmailConnectorError({ code: "missing-credential", message: "Gmail credential is not configured" })
  }
  return yield* decodeSecret(secret)
})
export const readGmailMessage = Effect.fn("GmailConnector.readMessage")(function*(
  scope: unknown,
  integration: unknown,
  messageId: unknown,
  options?: GmailConnectorOptions
) {
  if (typeof messageId !== "string" || messageId.length === 0) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail message reference is not usable" })
  }
  const provedIntegration = yield* decodeIntegration(integration)
  const mailbox = yield* decodeMailbox(provedIntegration.configuration)
  const token = yield* resolveGmailToken(scope, integration)
  return yield* getMessage(mailbox.mailbox, messageId, token, options).pipe(
    Effect.mapError(transportError)
  )
})
export const organizeGmailMessage = Effect.fn("GmailConnector.organize")(function*(
  scope: unknown,
  integration: unknown,
  messageId: unknown,
  label: unknown,
  moveTo: unknown,
  options?: GmailConnectorOptions
) {
  const provedLabel = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(label).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Gmail label is not usable" }))
  )
  const provedMove = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(moveTo).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Gmail destination is not usable" }))
  )
  if (typeof messageId !== "string" || messageId.length === 0) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail message reference is not usable" })
  }
  const provedIntegration = yield* decodeIntegration(integration)
  const mailbox = yield* decodeMailbox(provedIntegration.configuration)
  const token = yield* resolveGmailToken(scope, integration)
  const current = yield* getMessage(mailbox.mailbox, messageId, token, options).pipe(
    Effect.mapError(transportError)
  )
  const desired = unionLabelIds(current.labelIds, [provedLabel, provedMove])
  const shouldRemoveInbox = provedMove !== "INBOX" && current.labelIds.includes("INBOX")
  const alreadyHasLabel = current.labelIds.includes(provedLabel)
  const alreadyMoved = provedMove === "INBOX" || current.labelIds.includes(provedMove) || !shouldRemoveInbox && alreadyHasLabel
  if (alreadyHasLabel && alreadyMoved) {
    return yield* Schema.decodeUnknownEffect(GmailOrganizeResult, { onExcessProperty: "error" })({ applied: true, moved: false }).pipe(
      Effect.mapError(() => new GmailConnectorError({ code: "api", message: "Gmail organize result is not usable" }))
    )
  }
  const addLabelIds = desired.filter((entry) => !current.labelIds.includes(entry))
  const removeLabelIds = shouldRemoveInbox ? ["INBOX"] : []
  yield* modifyMessage(mailbox.mailbox, messageId, { addLabelIds, removeLabelIds }, token, options).pipe(
    Effect.mapError(transportError)
  )
  const moved = removeLabelIds.length > 0 || addLabelIds.includes(provedMove)
  return yield* Schema.decodeUnknownEffect(GmailOrganizeResult, { onExcessProperty: "error" })({ applied: true, moved }).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "api", message: "Gmail organize result is not usable" }))
  )
})
export const checkGmailConnection = (
  scope: unknown,
  integration: unknown,
  options?: GmailConnectorOptions
): Effect.Effect<GmailConnectionStatus, never, CredentialRepository | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const provedScope = yield* decodeScope(scope).pipe(Effect.option)
    const provedIntegration = yield* decodeIntegration(integration).pipe(Effect.option)
    if (provedScope._tag === "None" || provedIntegration._tag === "None") {
      return { ok: false, configured: false, mailbox: "", reason: "Integration configuration is not usable", code: "invalid-contract" }
    }
    const scopeValue = provedScope.value
    const integrationValue = provedIntegration.value
    const mailbox = yield* decodeMailbox(integrationValue.configuration).pipe(Effect.option)
    if (mailbox._tag === "None") {
      return { ok: false, configured: false, mailbox: "", reason: "Mailbox configuration is not usable", code: "invalid-contract" }
    }
    const mailboxValue = mailbox.value
    const base: GmailConnectionStatus = { ok: false, configured: false, mailbox: mailboxValue.mailbox }
    const tokenResult = yield* resolveGmailToken(scopeValue, integrationValue).pipe(
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
    const configuredBase: GmailConnectionStatus = { ...base, configured: true }
    const listed = yield* listMessages(mailboxValue.mailbox, token, options).pipe(
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
    return { ...configuredBase, ok: true, messages: listed.value.length }
  })
export const getPollHistoryId = Effect.fn("GmailConnector.getPollHistoryId")(function*(
  scope: PersonalScope,
  integrationId: string
) {
  const sql = yield* SqlClient
  yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Credential scope is not usable" }))
  )
  yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(integrationId).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Integration reference is not usable" }))
  )
  const rows = yield* sql<{ last_history_id: string }>`SELECT last_history_id FROM automation_gmail_poll_state WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND integration_id=${integrationId}`.pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "connection", message: "Gmail poll state is not readable" }))
  )
  const first = rows[0]
  if (first === undefined) return null
  if (typeof first.last_history_id !== "string" || first.last_history_id.length === 0) {
    return yield* new GmailConnectorError({ code: "api", message: "Gmail poll state is not usable" })
  }
  return first.last_history_id
})
export const hasSeenMessage = Effect.fn("GmailConnector.hasSeen")(function*(
  scope: PersonalScope,
  integrationId: string,
  messageId: string
) {
  const sql = yield* SqlClient
  const rows = yield* sql<{ message_id: string }>`SELECT message_id FROM automation_gmail_seen WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND integration_id=${integrationId} AND message_id=${messageId}`.pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "connection", message: "Gmail seen state is not readable" }))
  )
  return rows.length > 0
})
export const markSeenMessage = Effect.fn("GmailConnector.markSeen")(function*(
  scope: PersonalScope,
  integrationId: string,
  messageId: string
) {
  const sql = yield* SqlClient
  const seenAt = String(yield* Clock.currentTimeMillis)
  yield* sql`INSERT INTO automation_gmail_seen ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, integration_id: integrationId, message_id: messageId, seen_at: seenAt })} ON CONFLICT(owner_id, project_id, integration_id, message_id) DO NOTHING`.pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "connection", message: "Gmail seen state is not writable" }))
  )
})
export const isSentMessage = Effect.fn("GmailConnector.isSent")(function*(
  scope: PersonalScope,
  messageId: string
) {
  const sql = yield* SqlClient
  const rows = yield* sql<{ message_id: string }>`SELECT message_id FROM automation_gmail_sent WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND message_id=${messageId}`.pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "connection", message: "Gmail sent state is not readable" }))
  )
  return rows.length > 0
})
export const markSentMessage = Effect.fn("GmailConnector.markSent")(function*(
  scope: PersonalScope,
  messageId: string
) {
  const sql = yield* SqlClient
  const sentAt = String(yield* Clock.currentTimeMillis)
  yield* sql`INSERT INTO automation_gmail_sent ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, message_id: messageId, sent_at: sentAt })} ON CONFLICT(owner_id, project_id, message_id) DO NOTHING`.pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "connection", message: "Gmail sent state is not writable" }))
  )
})
export const savePollHistoryId = Effect.fn("GmailConnector.savePoll")(function*(
  scope: PersonalScope,
  integrationId: string,
  historyId: string
) {
  const sql = yield* SqlClient
  if (typeof historyId !== "string" || historyId.length === 0) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail history marker is not usable" })
  }
  const stamp = String(yield* Clock.currentTimeMillis)
  yield* sql`INSERT INTO automation_gmail_poll_state ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, integration_id: integrationId, last_history_id: historyId, updated_at: stamp })} ON CONFLICT(owner_id, project_id, integration_id) DO UPDATE SET last_history_id=excluded.last_history_id, updated_at=excluded.updated_at`.pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "connection", message: "Gmail poll state is not writable" }))
  )
})
export const pollGmailInbox = Effect.fn("GmailConnector.pollInbox")(function*(
  scope: unknown,
  integration: unknown,
  options?: GmailConnectorOptions
) {
  const provedScope = yield* decodeScope(scope)
  const provedIntegration = yield* decodeIntegration(integration)
  const mailbox = yield* decodeMailbox(provedIntegration.configuration)
  const token = yield* resolveGmailToken(scope, integration)
  const previous = yield* getPollHistoryId(provedScope, provedIntegration.id).pipe(
    Effect.mapError(transportErrorFromConnector)
  )
  const listed = previous === null
    ? yield* listMessages(mailbox.mailbox, token, options).pipe(Effect.map((messages) => ({ added: messages, historyId: "" })), Effect.mapError(transportError))
    : yield* listHistory(mailbox.mailbox, previous, token, options).pipe(Effect.mapError(transportError))
  let historyId = listed.historyId
  const fresh: Array<GmailMessage> = []
  let skippedSeen = 0
  let skippedSent = 0
  for (const entry of listed.added) {
    const seen = yield* hasSeenMessage(provedScope, provedIntegration.id, entry.id).pipe(Effect.mapError(transportErrorFromConnector))
    if (seen) {
      skippedSeen += 1
      continue
    }
    const sent = yield* isSentMessage(provedScope, entry.id).pipe(Effect.mapError(transportErrorFromConnector))
    if (sent) {
      skippedSent += 1
      yield* markSeenMessage(provedScope, provedIntegration.id, entry.id).pipe(Effect.mapError(transportErrorFromConnector))
      continue
    }
    const full = yield* getMessage(mailbox.mailbox, entry.id, token, options).pipe(Effect.mapError(transportError))
    if (full.labelIds.includes("SENT")) {
      if (full.historyId.length > 0) historyId = full.historyId
      skippedSent += 1
      yield* markSentMessage(provedScope, entry.id).pipe(Effect.mapError(transportErrorFromConnector))
      yield* markSeenMessage(provedScope, provedIntegration.id, entry.id).pipe(Effect.mapError(transportErrorFromConnector))
      continue
    }
    if (full.historyId.length > 0) historyId = full.historyId
    yield* markSeenMessage(provedScope, provedIntegration.id, entry.id).pipe(Effect.mapError(transportErrorFromConnector))
    fresh.push(full)
  }
  if (historyId.length > 0) {
    yield* savePollHistoryId(provedScope, provedIntegration.id, historyId).pipe(Effect.mapError(transportErrorFromConnector))
  }
  yield* Effect.logInfo("gmail poll completed", { integrationId: provedIntegration.id, fresh: fresh.length, skippedSeen, skippedSent })
  const result: GmailPollResult = { historyId, fresh, skippedSeen, skippedSent }
  return result
})
export const makeGmailConnectorExtension = (options: GmailConnectorOptions | undefined, services: GmailConnectorServices) => {
  const action = defineAction({
    definition: emailOrganizeActionReference,
    title: "Email organize message",
    integration: gmailIntegrationReference,
    capabilities: ["label", "move"],
    argumentsSchema: GmailOrganizeArguments,
    resultSchema: GmailOrganizeResult,
    integrationConfigurationSchema: GmailMailboxConfiguration,
    handler: (
      args: typeof GmailOrganizeArguments.Type,
      configuration: typeof GmailMailboxConfiguration.Type,
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
      const storedMailbox = yield* Schema.decodeUnknownEffect(GmailMailboxConfiguration, { onExcessProperty: "error" })(stored.configuration.configuration).pipe(
        Effect.mapError(() => ({ code: "invalid-contract", message: "Mailbox configuration is not usable" }) as AutomationFailure)
      )
      if (storedMailbox.mailbox !== configuration.mailbox) {
        return yield* Effect.fail({ code: "invalid-contract", message: "Mailbox does not match the permitted configuration" } as AutomationFailure)
      }
      const credentials = yield* CredentialRepository.pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      const storedCredentials: unknown = stored.configuration.credentials
      const slot = typeof storedCredentials === "object" && storedCredentials !== null ? (storedCredentials as Record<string, unknown>)[GmailCredentialSlot] : undefined
      const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(
        Effect.mapError(() => ({ code: "missing-credential", message: "Gmail credential is not configured" }) as AutomationFailure)
      )
      const secret = yield* credentials.resolveSecret(provedContext.scope, reference.credentialId).pipe(
        Effect.mapError(() => ({ code: "connection", message: "Credential resolution failed" }) as AutomationFailure)
      )
      if (secret === null) {
        return yield* Effect.fail({ code: "missing-credential", message: "Gmail credential is not configured" } as AutomationFailure)
      }
      const token = yield* decodeSecret(secret).pipe(
        Effect.mapError((error) => connectorFailure(error))
      )
      const current = yield* getMessage(configuration.mailbox, args.messageId, token, options).pipe(
        Effect.mapError((error) => transportFailure(error))
      )
      const desired = unionLabelIds(current.labelIds, [args.label, args.moveTo])
      const shouldRemoveInbox = args.moveTo !== "INBOX" && current.labelIds.includes("INBOX")
      if (current.labelIds.includes(args.label) && (args.moveTo === "INBOX" || current.labelIds.includes(args.moveTo) || !shouldRemoveInbox)) {
        return { applied: true, moved: false }
      }
      const addLabelIds = desired.filter((entry) => !current.labelIds.includes(entry))
      const removeLabelIds = shouldRemoveInbox ? ["INBOX"] : []
      yield* modifyMessage(configuration.mailbox, args.messageId, { addLabelIds, removeLabelIds }, token, options).pipe(
        Effect.mapError((error) => transportFailure(error))
      )
      return { applied: true, moved: removeLabelIds.length > 0 || addLabelIds.includes(args.moveTo) }
    })
  })
  const servicesLayer = Layer.mergeAll(
    Layer.succeed(ConfigurationRepository, services.configurations),
    Layer.succeed(CredentialRepository, services.credentials),
    Layer.succeed(HttpClient.HttpClient, services.http)
  )
  const installed: InstalledAction = {
    kind: action.kind,
    definition: action.definition,
    title: action.title,
    integration: action.integration,
    capabilities: action.capabilities,
    argumentsSchema: action.argumentsSchema,
    resultSchema: action.resultSchema,
    integrationConfigurationSchema: action.integrationConfigurationSchema,
    invoke: (arguments_, configuration, context) => action.invoke(arguments_, configuration, context).pipe(
      Effect.provide(servicesLayer)
    )
  }
  return {
    action,
    extension: defineExtension({
      integrations: [gmailIntegrationDefinition],
      triggers: [emailTriggerDefinition],
      actions: [installed],
      routines: [gmailClassificationTemplate]
    })
  }
}
function decodeScope(scope: unknown): Effect.Effect<PersonalScope, GmailConnectorError> {
  return Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Credential scope is not usable" }))
  )
}
function decodeIntegration(integration: unknown): Effect.Effect<IntegrationConfiguration, GmailConnectorError> {
  return Schema.decodeUnknownEffect(IntegrationConfiguration, { onExcessProperty: "error" })(integration).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Integration configuration is not usable" }))
  )
}
function decodeMailbox(configuration: unknown): Effect.Effect<typeof GmailMailboxConfiguration.Type, GmailConnectorError> {
  return Schema.decodeUnknownEffect(GmailMailboxConfiguration, { onExcessProperty: "error" })(configuration).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Mailbox configuration is not usable" }))
  )
}
const GmailOauthJson = Schema.fromJsonString(Schema.Unknown)
function decodeSecret(secret: Uint8Array): Effect.Effect<string, GmailConnectorError> {
  return Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(secret),
      catch: () => new GmailConnectorError({ code: "invalid-credential", message: "Gmail credential is not usable" })
    })
    if (text.length === 0) {
      return yield* new GmailConnectorError({ code: "invalid-credential", message: "Gmail credential is not usable" })
    }
    const decoded = yield* Schema.decodeUnknownEffect(GmailOauthJson, { onExcessProperty: "ignore" })(text).pipe(Effect.option)
    if (decoded._tag === "Some") {
      const value = decoded.value
      if (typeof value === "string" && value.length > 0) return value
      if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>
        for (const key of ["accessToken", "access_token", "token"]) {
          const candidate = record[key]
          if (typeof candidate === "string" && candidate.length > 0) return candidate
        }
      }
    }
    return text
  })
}
function transportError(error: GmailTransportError): GmailConnectorError {
  if (error.code === "auth" || error.code === "forbidden" || error.code === "not-found" || error.code === "rate-limited" || error.code === "connection" || error.code === "api" || error.code === "invalid-contract") {
    if (error.status === undefined) return new GmailConnectorError({ code: error.code, message: error.message })
    return new GmailConnectorError({ code: error.code, message: error.message, status: error.status })
  }
  return new GmailConnectorError({ code: "api", message: "Gmail request failed" })
}
function transportErrorFromConnector(error: GmailConnectorError): GmailTransportError {
  return new GmailTransportError({ code: error.code === "missing-credential" || error.code === "invalid-credential" ? "auth" : "api", message: error.message })
}
function connectorFailure(error: GmailConnectorError): AutomationFailure {
  return { code: error.code, message: error.message }
}
function transportFailure(error: GmailTransportError): AutomationFailure {
  return { code: error.code, message: error.message }
}
