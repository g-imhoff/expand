import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  PersonalScope,
  gmailIntegrationReference,
  gmailLabelActionReference,
  gmailTriggerReference,
  sameDefinition
} from "@expand/contracts/automation"
import type { ActionGrant, AutomationRun, DefinitionReference, IntegrationConfiguration, RoutineConfiguration } from "@expand/contracts/automation"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReady } from "../migrations/sqlite.js"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import { StorageError, decode, encodeJson, readJson } from "./persistence-models.js"
import { GmailConnectorError, resolveGmailToken } from "./gmail-client.js"
import type { GmailConnectorOptions } from "./gmail-client.js"
import { getMessage, listMessages } from "./gmail-transport.js"
import type { GmailListPage } from "./gmail-transport.js"

export interface GmailPollOptions extends GmailConnectorOptions {
  readonly query?: string
  readonly maxResults?: number
}

export interface GmailPollSummary {
  readonly polled: number
  readonly ingested: number
  readonly skippedSelf: number
  readonly skippedSeen: number
  readonly deliveryIds: ReadonlyArray<string>
}

export interface GmailPolledMessage {
  readonly id: string
  readonly threadId?: string
  readonly labelIds: ReadonlyArray<string>
  readonly from?: string
}

export const GmailPollState = Schema.Struct({
  historyId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  seenIds: Schema.Array(Schema.String.check(Schema.isMinLength(1)))
})
export type GmailPollState = typeof GmailPollState.Type

export const ensureGmailPollTables = Effect.fn("GmailPoll.ensureTables")(function*() {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS automation_gmail_poll_state (
    owner_id TEXT NOT NULL, project_id TEXT NOT NULL, integration_id TEXT NOT NULL,
    history_id TEXT, seen_json TEXT NOT NULL,
    UNIQUE(owner_id, project_id, integration_id)
  ) STRICT`
  yield* sql`CREATE TABLE IF NOT EXISTS automation_gmail_sent (
    owner_id TEXT NOT NULL, project_id TEXT NOT NULL, integration_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    UNIQUE(owner_id, project_id, integration_id, message_id)
  ) STRICT`
})

export const loadGmailPollState = Effect.fn("GmailPoll.loadState")(function*(scope: PersonalScope, integrationId: string) {
  yield* DatabaseReady
  const sql = yield* SqlClient
  yield* ensureGmailPollTables()
  const rows = yield* sql<PollRow>`SELECT history_id, seen_json FROM automation_gmail_poll_state WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND integration_id=${integrationId}`
  const row = rows[0]
  if (row === undefined) return { seenIds: [] } as GmailPollState
  const seen = yield* readJson(Schema.Array(Schema.String.check(Schema.isMinLength(1))), row.seen_json).pipe(
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>))
  )
  if (row.history_id === null) return { seenIds: [...seen] } as GmailPollState
  return { historyId: row.history_id, seenIds: [...seen] } as GmailPollState
})

export const saveGmailPollState = Effect.fn("GmailPoll.saveState")(function*(scope: PersonalScope, integrationId: string, state: GmailPollState) {
  yield* DatabaseReady
  const sql = yield* SqlClient
  yield* ensureGmailPollTables()
  yield* decode(PersonalScope, scope)
  const proved = yield* decode(GmailPollState, state)
  const seenJson = encodeJson([...proved.seenIds])
  const historyId = proved.historyId ?? null
  yield* sql`INSERT INTO automation_gmail_poll_state (owner_id, project_id, integration_id, history_id, seen_json)
    VALUES (${scope.ownerId}, ${scope.projectId}, ${integrationId}, ${historyId}, ${seenJson})
    ON CONFLICT(owner_id, project_id, integration_id) DO UPDATE SET history_id=excluded.history_id, seen_json=excluded.seen_json`
})

export const markGmailSent = Effect.fn("GmailPoll.markSent")(function*(scope: PersonalScope, integrationId: string, messageId: string) {
  yield* DatabaseReady
  const sql = yield* SqlClient
  yield* ensureGmailPollTables()
  yield* decode(PersonalScope, scope)
  if (typeof messageId !== "string" || messageId.length === 0) {
    return yield* new StorageError({ code: "invalid", message: "Invalid sent message id" })
  }
  yield* sql`INSERT OR IGNORE INTO automation_gmail_sent (owner_id, project_id, integration_id, message_id)
    VALUES (${scope.ownerId}, ${scope.projectId}, ${integrationId}, ${messageId})`
})

export const listGmailSentIds = Effect.fn("GmailPoll.listSent")(function*(scope: PersonalScope, integrationId: string) {
  yield* DatabaseReady
  const sql = yield* SqlClient
  yield* ensureGmailPollTables()
  yield* decode(PersonalScope, scope)
  const rows = yield* sql<SentRow>`SELECT message_id FROM automation_gmail_sent WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND integration_id=${integrationId} ORDER BY message_id`
  return rows.map((row) => row.message_id) as ReadonlyArray<string>
})

export const isSelfGmailMessage = (
  message: GmailPolledMessage,
  ownMailbox: string | undefined,
  sentIds: ReadonlyArray<string>
): boolean => {
  if (sentIds.includes(message.id)) return true
  if (message.labelIds.includes("SENT")) return true
  if (ownMailbox !== undefined && ownMailbox !== "me" && message.from !== undefined) {
    const mailbox = ownMailbox.trim().toLowerCase()
    const from = message.from.toLowerCase()
    if (mailbox.length > 0 && from.includes(mailbox)) return true
  }
  return false
}

export const formatGmailPollLog = (input: { readonly messageId: string; readonly applied?: boolean }): string =>
  input.applied === undefined
    ? `gmail message ${input.messageId} polled`
    : `gmail message ${input.messageId} applied=${input.applied ? "yes" : "no"}`

export const pollGmailInbox = Effect.fn("GmailPoll.poll")(function*(
  scope: PersonalScope,
  integrationId: string,
  options: GmailPollOptions = {}
) {
  yield* DatabaseReady
  yield* ensureGmailPollTables()
  const configurations = yield* ConfigurationRepository
  const executions = yield* ExecutionRepository
  const stored = yield* configurations.getIntegration(scope, integrationId)
  if (stored === null) {
    return yield* new GmailConnectorError({ code: "missing-credential", message: "Gmail integration is not configured" })
  }
  if (!sameDefinition(stored.configuration.definition, gmailIntegrationReference)) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Integration is not the Gmail connector" })
  }
  const token = yield* resolveGmailToken(scope, stored.configuration)
  const baseUrl = options.baseUrl ?? "https://gmail.googleapis.com"
  const timeoutMs = options.timeoutMs ?? 10000
  const mailbox = mailboxOf(stored.configuration.configuration)
  const ownMailbox = mailbox === "me" ? undefined : mailbox
  const prior = yield* loadGmailPollState(scope, integrationId).pipe(
    Effect.catch(() => Effect.succeed({ seenIds: [] } as GmailPollState))
  )
  const sentIds = yield* listGmailSentIds(scope, integrationId).pipe(
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>))
  )
  const seen = new Set(prior.seenIds)
  const refs: Array<{ readonly id: string; readonly threadId?: string }> = []
  let pageToken: string | undefined = undefined
  for (let page = 0; page < 10; page += 1) {
    const listed: GmailListPage = yield* listMessages({
      baseUrl, token, userId: mailbox,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(pageToken === undefined ? {} : { pageToken }),
      ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
      timeoutMs
    }).pipe(Effect.mapError((transport) => new GmailConnectorError({
      code: transport.code, message: transport.message,
      ...(transport.status === undefined ? {} : { status: transport.status }),
      ...(transport.retryAfterMs === undefined ? {} : { retryAfterMs: transport.retryAfterMs })
    })))
    for (const entry of listed.messages) refs.push(entry)
    if (listed.nextPageToken === undefined) break
    pageToken = listed.nextPageToken
  }
  const routines = yield* matchingGmailRoutines(configurations, scope, integrationId)
  let ingested = 0
  let skippedSelf = 0
  let skippedSeen = 0
  let historyId = prior.historyId
  const deliveryIds: Array<string> = []
  for (const ref of refs) {
    if (seen.has(ref.id)) {
      skippedSeen += 1
      continue
    }
    const full = yield* getMessage({ baseUrl, token, userId: mailbox, messageId: ref.id, timeoutMs }).pipe(
      Effect.mapError((transport) => new GmailConnectorError({
        code: transport.code, message: transport.message,
        ...(transport.status === undefined ? {} : { status: transport.status }),
        ...(transport.retryAfterMs === undefined ? {} : { retryAfterMs: transport.retryAfterMs })
      }))
    )
    if (full.historyId !== undefined) historyId = full.historyId
    const polled: GmailPolledMessage = {
      id: full.id,
      ...(full.threadId === undefined ? {} : { threadId: full.threadId }),
      labelIds: full.labelIds,
      ...(full.from === undefined ? {} : { from: full.from })
    }
    if (isSelfGmailMessage(polled, ownMailbox, sentIds)) {
      skippedSelf += 1
      seen.add(ref.id)
      continue
    }
    const payload = {
      messageId: full.id,
      ...(full.threadId === undefined ? {} : { threadId: full.threadId }),
      ...(full.subject === undefined ? {} : { subject: full.subject }),
      ...(full.from === undefined ? {} : { from: full.from }),
      ...(full.snippet === undefined ? {} : { snippet: full.snippet }),
      ...(full.body === undefined ? {} : { body: full.body })
    }
    const deliveryId = `${integrationId}:${full.id}`
    const delivery = {
      schemaVersion: 1 as const, id: deliveryId, scope,
      integration: { id: integrationId, definition: gmailIntegrationReference },
      externalId: full.id, trigger: gmailTriggerReference, payload
    }
    const raw = new TextEncoder().encode(encodeJson(payload))
    if (routines.length === 0) {
      seen.add(ref.id)
      continue
    }
    const targets = routines.map((routine) => ({
      jobId: `${deliveryId}:job:${routine.reference.routineId}`,
      run: buildGmailPollRun(scope, routine, `${deliveryId}:run:${routine.reference.routineId}`, deliveryId)
    }))
    yield* executions.ingest({ delivery, raw, targets }).pipe(
      Effect.catch(() => Effect.succeed({ deliveryId, jobIds: [], runIds: [] }))
    )
    seen.add(ref.id)
    ingested += 1
    deliveryIds.push(deliveryId)
  }
  const next: GmailPollState = {
    ...(historyId === undefined ? {} : { historyId }),
    seenIds: [...seen]
  }
  yield* saveGmailPollState(scope, integrationId, next).pipe(Effect.catch(() => Effect.void))
  const summary: GmailPollSummary = {
    polled: refs.length, ingested, skippedSelf, skippedSeen, deliveryIds
  }
  return summary
})

interface PollRow { readonly history_id: string | null; readonly seen_json: string }
interface SentRow { readonly message_id: string }

function mailboxOf(configuration: unknown): string {
  if (typeof configuration === "object" && configuration !== null && "mailbox" in configuration) {
    const value = (configuration as Record<string, unknown>)["mailbox"]
    if (typeof value === "string" && value.length > 0) return value
  }
  return "me"
}

const matchingGmailRoutines = Effect.fn("GmailPoll.matchingRoutines")(function*(
  configurations: ConfigurationRepository["Service"],
  scope: PersonalScope,
  integrationId: string
) {
  const heads = yield* configurations.listHeads(scope)
  const routines: Array<RoutineConfiguration> = []
  for (const listed of heads) {
    if (listed.head.status !== "enabled") continue
    const routine = yield* configurations.getRevision(scope, listed.routineId, listed.head.revision)
    if (routine === null) continue
    if (!sameDefinition(routine.process.trigger.definition, gmailTriggerReference)) continue
    if (routine.process.trigger.integration.id !== integrationId) continue
    if (!sameDefinition(routine.process.trigger.integration.definition, gmailIntegrationReference)) continue
    if (!routine.integrations.some((entry) => entry.id === integrationId && sameDefinition(entry.definition, gmailIntegrationReference))) continue
    routines.push(routine)
  }
  return routines as ReadonlyArray<RoutineConfiguration>
})

function gmailCapabilitiesFor(action: DefinitionReference): ReadonlyArray<string> {
  return sameDefinition(action, gmailLabelActionReference) ? ["label"] : []
}

function buildGmailPollRun(scope: PersonalScope, routine: RoutineConfiguration, runId: string, deliveryId: string): AutomationRun {
  const integrationIds = [...new Set(routine.integrations.map((entry) => entry.id))]
  const grants: Array<ActionGrant> = []
  const seen = new Set<string>()
  for (const steps of Object.values(routine.process.actions)) {
    for (const step of steps) {
      const key = `${step.integration.id} ${step.action.id}@${step.action.version}`
      if (seen.has(key)) continue
      seen.add(key)
      grants.push({ action: step.action, integrationId: step.integration.id, capabilities: [...gmailCapabilitiesFor(step.action)] })
    }
  }
  return {
    schemaVersion: 1, kind: "run", id: runId, scope,
    configuration: routine.reference,
    input: { kind: "input-reference", id: deliveryId },
    mode: "live",
    authority: { schemaVersion: 1, kind: "invocation-authority", scope, configuration: routine.reference, integrationIds, actionGrants: grants },
    state: { kind: "queued" },
    actions: []
  }
}
