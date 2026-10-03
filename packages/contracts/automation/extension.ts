import { Effect, Schema } from "effect"
import { AutomationError, AutomationFailure, decodeJson, InvocationContext, isJsonValue } from "./descriptors.js"
import type { DefinitionReference } from "./ids.js"
import type { ProcessDefinition } from "./process.js"

export interface IntegrationDefinition<S extends ContextFreeCodec = ContextFreeCodec> {
  readonly kind: "integration"
  readonly definition: DefinitionReference
  readonly title: string
  readonly capabilities: ReadonlyArray<string>
  readonly configurationSchema: S
}
export interface TriggerDefinition<C extends ContextFreeCodec = ContextFreeCodec, P extends ContextFreeCodec = ContextFreeCodec> {
  readonly kind: "trigger"
  readonly definition: DefinitionReference
  readonly title: string
  readonly integration: DefinitionReference
  readonly configurationSchema: C
  readonly payloadSchema: P
}
export interface ActionDefinition<A extends ContextFreeCodec = ContextFreeCodec, R extends ContextFreeCodec = ContextFreeCodec, C extends ContextFreeCodec = ContextFreeCodec, Requirements = never> {
  readonly kind: "action"
  readonly definition: DefinitionReference
  readonly title: string
  readonly integration: DefinitionReference
  readonly capabilities: ReadonlyArray<string>
  readonly argumentsSchema: A
  readonly resultSchema: R
  readonly integrationConfigurationSchema: C
  readonly handler: (arguments_: A["Type"], configuration: C["Type"], context: InvocationContext) => Effect.Effect<R["Type"], AutomationFailure, Requirements>
  readonly invoke: (arguments_: unknown, configuration: unknown, context: InvocationContext) => Effect.Effect<Schema.Json, AutomationError, Requirements>
}
export interface RoutineDefinition<C extends ContextFreeCodec = ContextFreeCodec> {
  readonly kind: "routine-template"
  readonly definition: DefinitionReference
  readonly title: string
  readonly configurationSchema: C
  readonly process: ProcessDefinition
}
export interface AutomationExtension<Requirements = never> {
  readonly integrations: ReadonlyArray<IntegrationDefinition>
  readonly triggers: ReadonlyArray<TriggerDefinition>
  readonly actions: ReadonlyArray<InstalledAction<Requirements>>
  readonly routines: ReadonlyArray<RoutineDefinition>
}

export type ContextFreeCodec = Schema.ConstraintCodec<unknown, unknown, never, never>
export type InstalledAction<Requirements = never> = Omit<ActionDefinition<ContextFreeCodec, ContextFreeCodec, ContextFreeCodec, Requirements>, "handler">
export const defineIntegration = <S extends ContextFreeCodec>(definition: Omit<IntegrationDefinition<S>, "kind">): IntegrationDefinition<S> => ({ kind: "integration", ...definition })
export const defineTrigger = <C extends ContextFreeCodec, P extends ContextFreeCodec>(definition: Omit<TriggerDefinition<C, P>, "kind">): TriggerDefinition<C, P> => ({ kind: "trigger", ...definition })
export const defineRoutine = <C extends ContextFreeCodec>(definition: Omit<RoutineDefinition<C>, "kind">): RoutineDefinition<C> => ({ kind: "routine-template", ...definition })
export const defineAction = <A extends ContextFreeCodec, R extends ContextFreeCodec, C extends ContextFreeCodec, Requirements = never>(
  definition: Omit<ActionDefinition<A, R, C, Requirements>, "kind" | "invoke">
): ActionDefinition<A, R, C, Requirements> => {
  const { argumentsSchema, integrationConfigurationSchema, resultSchema, handler } = definition
  return {
    kind: "action", ...definition,
    invoke: Effect.fn("AutomationExtension.invoke")(function*(arguments_: unknown, configuration: unknown, context: InvocationContext) {
      const args = yield* decodeJson(argumentsSchema, arguments_)
      const config = yield* decodeJson(integrationConfigurationSchema, configuration)
      const result = yield* handler(args, config, context).pipe(
        Effect.catch((failure) => decodeJson(AutomationFailure, failure).pipe(
          Effect.flatMap((error) => Effect.fail(new AutomationError({ code: "handler-failed", message: error.message, failure: error }))))))
      const encoded = yield* Schema.encodeUnknownEffect(resultSchema, { onExcessProperty: "error" })(result).pipe(
        Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: "Action result does not match its registered contract" })))
      if (!isJsonValue(encoded)) return yield* new AutomationError({ code: "invalid-contract", message: "Action result is not encoded JSON" })
      yield* decodeJson(resultSchema, encoded)
      return encoded
    })
  }
}
export const defineExtension = <Requirements = never>(extension: AutomationExtension<Requirements>): AutomationExtension<Requirements> => extension
