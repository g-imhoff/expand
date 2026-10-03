import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { CredentialReference } from "@expand/contracts/automation"
import { CredentialStatus, StoredCredential, decode } from "../../automation/persistence-models.js"

const secret = "t03-unit-secret-value"
const stored = { schemaVersion: 1, kind: "credential", credentialId: "account-1", secret } as const
const status = { credentialId: "account-1", version: 1, configured: true } as const

describe("credential models", () => {
  it.live("accepts exact stored credential and redacted status without secret fields", () => Effect.gen(function* () {
    expect(yield* decode(StoredCredential, stored)).toEqual(stored)
    expect(yield* decode(CredentialStatus, status)).toEqual(status)
    expect(yield* decode(CredentialReference, { schemaVersion: 1, kind: "credential-reference", credentialId: "account-1" })).toEqual({
      schemaVersion: 1, kind: "credential-reference", credentialId: "account-1"
    })
  }))
  it.live("rejects inline secret values and extra status fields without leaking the secret", () => Effect.gen(function* () {
    for (const invalid of [
      { ...stored, secret: undefined },
      { ...stored, credentialId: "" }
    ]) {
      const exit = yield* Effect.exit(decode(StoredCredential, invalid))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).not.toContain(secret)
    }
    for (const invalid of [{ ...status, version: 0 }, { ...status, configured: false }, { ...status, secret }]) {
      const exit = yield* Effect.exit(decode(CredentialStatus, invalid))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).not.toContain(secret)
    }
    const inline = yield* Effect.exit(decode(CredentialReference, { schemaVersion: 1, kind: "credential-reference", credentialId: "account-1", value: secret }))
    expect(Exit.isFailure(inline)).toBe(true)
    if (Exit.isFailure(inline)) expect(String(Cause.squash(inline.cause))).not.toContain(secret)
  }))
  it.live("never exposes the secret through redacted status encoding", () => Effect.gen(function* () {
    const value = yield* decode(CredentialStatus, status)
    expect(JSON.stringify(value)).not.toContain(secret)
    expect(JSON.stringify([value])).not.toContain(secret)
    expect(Object.keys(value).sort()).toEqual(["configured", "credentialId", "version"])
  }))
})
