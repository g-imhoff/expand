import { Schema } from "effect"
import { DomainEventMeta, withMeta } from "@expand/contracts/events/meta"

export const AutomationEvent = (() => {
  const AutomationEventMeta = {
    ...DomainEventMeta,
    projectId: Schema.String,
    ownerId: Schema.String
  }

  return Schema.TaggedUnion(
    withMeta(AutomationEventMeta, {
      AutomationRoutineChanged: {
        routineId: Schema.String,
        revision: Schema.Int,
        status: Schema.Literals(["enabled", "paused", "deleted"])
      },
      AutomationIntegrationChanged: {
        integrationId: Schema.String
      },
      AutomationCredentialChanged: {
        credentialId: Schema.String,
        version: Schema.Int
      }
    })
  )
})()

export type AutomationEvent = typeof AutomationEvent.Type

export const {
  AutomationRoutineChanged,
  AutomationIntegrationChanged,
  AutomationCredentialChanged
} = AutomationEvent.cases
