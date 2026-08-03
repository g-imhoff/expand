export const ENVELOPE_VERSION = "expand/v1" as const

export const makeEnvelope = <Kind extends string, Body extends object>(
  kind: Kind,
  body: Body & { apiVersion?: never; kind?: never }
): { apiVersion: typeof ENVELOPE_VERSION; kind: Kind } & Body => ({
  apiVersion: ENVELOPE_VERSION,
  kind,
  ...body
})
