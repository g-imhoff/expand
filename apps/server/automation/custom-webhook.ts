import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import {
  CredentialReference,
  LocalId,
  PersonalScope,
  sameDefinition,
} from "@expand/contracts/automation"
import { CustomWebhookCredentialSlot } from "@expand/contracts/automation/custom"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import { StorageError, encodeJson } from "./persistence-models.js"
import type { AutomationRegistry } from "./registry.js"

export interface CustomWebhookServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly executions: ExecutionRepository["Service"]
}

export interface CustomWebhookInput {
  readonly ownerId: string
  readonly projectId: string
  readonly integrationId: string
  readonly deliveryId: string
  readonly signature: string | undefined
  readonly raw: Uint8Array
}

export type CustomWebhookOutcome =
  | { readonly status: 200; readonly accepted: false }
  | { readonly status: 200; readonly accepted: true; readonly deliveryId: string; readonly jobIds: ReadonlyArray<string>; readonly runIds: ReadonlyArray<string> }
  | { readonly status: 401; readonly accepted: false }
  | { readonly status: 400; readonly accepted: false; readonly field: string; readonly message: string }
  | { readonly status: 404; readonly accepted: false; readonly message: string }
  | { readonly status: 409; readonly accepted: false; readonly message: string }

export const verifyCustomSignature = (
  secret: Uint8Array,
  raw: Uint8Array,
  signatureHeader: string | undefined,
): boolean => {
  if (typeof signatureHeader !== "string") return false
  const prefix = "sha256="
  if (!signatureHeader.startsWith(prefix)) return false
  const hex = signatureHeader.slice(prefix.length)
  if (hex.length !== 64) return false
  if (!/^[0-9a-f]{64}$/u.test(hex)) return false
  let expectedHex: string
  try {
    expectedHex = createHmac("sha256", Buffer.from(secret)).update(Buffer.from(raw)).digest("hex")
  } catch {
    return false
  }
  const left = Buffer.from(`${prefix}${expectedHex}`, "utf8")
  const right = Buffer.from(signatureHeader, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

export const makeCustomWebhookHandler = (services: CustomWebhookServices, registry: AutomationRegistry) => {
  const handle = (input: CustomWebhookInput): Effect.Effect<CustomWebhookOutcome, StorageError> =>
    Effect.gen(function* () {
      for (const [field, value] of [["ownerId", input.ownerId], ["projectId", input.projectId], ["integrationId", input.integrationId], ["deliveryId", input.deliveryId]] as const) {
        const checked = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(value).pipe(Effect.option)
        if (checked._tag === "None") return { status: 400, accepted: false, field, message: `${field} is not usable` } as const
      }
      if (!(input.raw instanceof Uint8Array)) return { status: 400, accepted: false, field: "body", message: "body is not usable" } as const
      const scope = { ownerId: input.ownerId, projectId: input.projectId }
      const provedScope = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(Effect.option)
      if (provedScope._tag === "None") return { status: 400, accepted: false, field: "ownerId", message: "ownerId is not usable" } as const
      const stored = yield* services.configurations.getIntegration(provedScope.value, input.integrationId)
      if (stored === null) return { status: 404, accepted: false, message: "Integration is not configured" } as const
      const slot: unknown = stored.configuration.credentials[CustomWebhookCredentialSlot]
      const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(Effect.option)
      if (reference._tag === "None") return { status: 401, accepted: false } as const
      const secret = yield* services.credentials.resolveSecret(provedScope.value, reference.value.credentialId)
      if (secret === null || !(secret instanceof Uint8Array) || secret.length === 0) return { status: 401, accepted: false } as const
      if (!verifyCustomSignature(new Uint8Array(secret), input.raw, input.signature)) return { status: 401, accepted: false } as const
      const textOption = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(input.raw),
        catch: () => new StorageError({ code: "invalid", message: "body is not usable" }),
      }).pipe(Effect.option)
      if (textOption._tag === "None") return { status: 400, accepted: false, field: "body", message: "body is not usable" } as const
      const text = textOption.value
      const parsed = yield* Schema.decodeUnknownEffect(JsonUnknown, { onExcessProperty: "ignore" })(text).pipe(Effect.option)
      if (parsed._tag === "None") return { status: 400, accepted: false, field: "body", message: "body is not usable" } as const
      const body = yield* Schema.decodeUnknownEffect(CustomBody, { onExcessProperty: "error" })(parsed.value).pipe(
        Effect.mapError((error) => fieldOf(error)),
        Effect.option,
      )
      if (body._tag === "None") {
        const rawBody = parsed.value as Record<string, unknown>
        const field = typeof rawBody?.routineId === "string" && rawBody.routineId.length > 0 ? "payload" : "routineId"
        return { status: 400, accepted: false, field, message: `${field} is not usable` } as const
      }
      const head = yield* services.configurations.getHead(provedScope.value, body.value.routineId)
      if (head === null) return { status: 404, accepted: false, message: "Routine does not exist" } as const
      if (head.status !== "enabled") return { status: 200, accepted: false } as const
      const revision = yield* services.configurations.getRevision(provedScope.value, body.value.routineId, head.revision)
      if (revision === null) return { status: 404, accepted: false, message: "Routine does not exist" } as const
      if (revision.process.trigger.integration.id !== input.integrationId) return { status: 404, accepted: false, message: "Routine does not use this integration" } as const
      const payloadSchema = yield* registry.triggerPayloadSchema(revision.process.trigger.definition).pipe(
        Effect.mapError(() => new StorageError({ code: "missing", message: "Trigger is not registered" })),
        Effect.option,
      )
      if (payloadSchema._tag === "None") return { status: 404, accepted: false, message: "Trigger is not registered" } as const
      const payload = yield* Schema.decodeUnknownEffect(payloadSchema.value, { onExcessProperty: "error" })(body.value.payload).pipe(
        Effect.mapError((error) => fieldOf(error)),
        Effect.option,
      )
      if (payload._tag === "None") {
        const failed = yield* Schema.decodeUnknownEffect(payloadSchema.value, { onExcessProperty: "error" })(body.value.payload).pipe(
          Effect.flip,
          Effect.map((error) => fieldOf(error)),
          Effect.orElseSucceed(() => "payload"),
        )
        return { status: 400, accepted: false, field: failed, message: `${failed} is not usable` } as const
      }
      const catalog = registry.catalog()
      const actionGrants: Array<{ action: { id: string; version: number }; integrationId: string; capabilities: ReadonlyArray<string> }> = []
      const seen = new Set<string>()
      for (const steps of Object.values(revision.process.actions)) {
        for (const step of steps) {
          const key = encodeJson([step.action.id, step.action.version, step.integration.id])
          if (seen.has(key)) continue
          seen.add(key)
          const descriptor = catalog.definitions.find((entry) => entry.kind === "action" && sameDefinition(entry.definition, step.action))
          if (descriptor === undefined || descriptor.kind !== "action") return { status: 400, accepted: false, field: "actions", message: "actions is not usable" } as const
          actionGrants.push({ action: { ...step.action }, integrationId: step.integration.id, capabilities: [...descriptor.capabilities] })
        }
      }
      const storedDeliveryId = `${input.deliveryId}:${input.integrationId}`
      const jobId = `${storedDeliveryId}:${body.value.routineId}:job`
      const runId = `${storedDeliveryId}:${body.value.routineId}:run`
      const delivery = {
        schemaVersion: 1 as const,
        id: storedDeliveryId,
        scope: provedScope.value,
        integration: { id: stored.configuration.id, definition: stored.configuration.definition },
        externalId: input.deliveryId,
        trigger: { ...revision.process.trigger.definition },
        payload: body.value.payload,
      }
      const run = {
        schemaVersion: 1 as const,
        kind: "run" as const,
        id: runId,
        scope: provedScope.value,
        configuration: { routineId: body.value.routineId, revision: head.revision },
        input: { kind: "input-reference" as const, id: storedDeliveryId },
        mode: "live" as const,
        authority: {
          schemaVersion: 1 as const,
          kind: "invocation-authority" as const,
          scope: provedScope.value,
          configuration: { routineId: body.value.routineId, revision: head.revision },
          integrationIds: revision.integrations.map((integration) => integration.id),
          actionGrants,
        },
        state: { kind: "queued" as const },
        actions: [],
      }
      const ingestOnce = () => services.executions.ingest({ delivery, raw: input.raw, targets: [{ jobId, run }] })
      const retried = ingestOnce().pipe(
        Effect.catch((error) => {
          if (error instanceof StorageError && error.code === "storage") return ingestOnce()
          return Effect.fail(error)
        }),
      )
      const outcome = yield* retried.pipe(
        Effect.map((ok) => ({ status: 200, accepted: true, deliveryId: input.deliveryId, jobIds: [...ok.jobIds], runIds: [...ok.runIds] }) as CustomWebhookOutcome),
        Effect.catch((error) => {
          if (error instanceof StorageError && error.code === "conflict") return Effect.succeed({ status: 409, accepted: false, message: "Delivery key was already used with different input" } as CustomWebhookOutcome)
          if (error instanceof StorageError && error.code === "missing") return Effect.succeed({ status: 404, accepted: false, message: "Routine or integration is not configured" } as CustomWebhookOutcome)
          if (error instanceof StorageError && error.code === "invalid") return Effect.succeed({ status: 400, accepted: false, field: "payload", message: "payload is not usable" } as CustomWebhookOutcome)
          return Effect.fail(error)
        }),
      )
      return outcome
    })
  return { handle }
}

const JsonUnknown = Schema.fromJsonString(Schema.Unknown)

const CustomBody = Schema.Struct({
  routineId: LocalId,
  payload: Schema.Json,
})

const fieldOf = (error: unknown): string => {
  const issues = (error as { readonly issues?: ReadonlyArray<{ readonly path?: ReadonlyArray<unknown> }> })?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    const path = issues[0]?.path
    if (Array.isArray(path) && path.length > 0 && typeof path[0] === "string") return path[0]
  }
  const path = (error as { readonly path?: ReadonlyArray<unknown> })?.path
  if (Array.isArray(path) && path.length > 0 && typeof path[0] === "string") return path[0]
  return "payload"
}
