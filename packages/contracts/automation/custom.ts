import { Schema } from "effect"
import { JsonValue } from "./descriptors.js"
import { LocalId } from "./ids.js"
import { defineTrigger } from "./extension.js"
import type { ContextFreeCodec, TriggerDefinition } from "./extension.js"

export const CustomWebhookCredentialSlot = "webhook"

export type CustomTriggerDefinition<C extends ContextFreeCodec = ContextFreeCodec, P extends ContextFreeCodec = ContextFreeCodec> = TriggerDefinition<C, P>

export const defineCustomTrigger = defineTrigger

export const CustomWebhookBody = Schema.Struct({
  routineId: LocalId,
  payload: JsonValue,
})
export type CustomWebhookBody = typeof CustomWebhookBody.Type
