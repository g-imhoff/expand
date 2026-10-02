import { Schema } from "effect"

export const DefinitionId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/, {
  toJsonSchema: () => ({ pattern: "^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$" })
}))
export const PositiveVersion = Schema.Int.check(Schema.isGreaterThan(0))
export const LocalId = Schema.String.check(Schema.isMinLength(1))
export const DefinitionReference = Schema.Struct({ id: DefinitionId, version: PositiveVersion })
export type DefinitionReference = typeof DefinitionReference.Type
export const PersonalScope = Schema.Struct({ ownerId: LocalId, projectId: LocalId })
export type PersonalScope = typeof PersonalScope.Type
export const ConfigurationReference = Schema.Struct({ routineId: LocalId, revision: PositiveVersion })
export type ConfigurationReference = typeof ConfigurationReference.Type
export const IntegrationReference = Schema.Struct({ id: LocalId, definition: DefinitionReference })
export type IntegrationReference = typeof IntegrationReference.Type
export const CredentialReference = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("credential-reference"), credentialId: LocalId
})
export type CredentialReference = typeof CredentialReference.Type
export const definitionKey = (reference: DefinitionReference): string => `${reference.id}@${reference.version}`
export const sameDefinition = (left: DefinitionReference, right: DefinitionReference): boolean =>
  left.id === right.id && left.version === right.version
