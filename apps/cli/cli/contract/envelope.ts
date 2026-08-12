import { ENVELOPE_VERSION } from "@expand/contracts/cli/version"

export const makeEnvelope = <Kind extends string, Body extends object>(
  kind: Kind,
  body: Body & { apiVersion?: never; kind?: never }
): { apiVersion: typeof ENVELOPE_VERSION; kind: Kind } & Body => ({
  apiVersion: ENVELOPE_VERSION,
  kind,
  ...body
})
