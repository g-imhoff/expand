import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { createHmac } from "node:crypto"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { decodePrConflictEvent, makePrConflictWebhookHandler, verifyPrConflictSignature } from "../../automation/pr-conflict-webhook.js"
import { buildPrConflictProcess, makeConflictExtension } from "@expand/contracts/automation/conflicts"

const scope = { ownerId: "conflict-owner", projectId: "conflict-project" }
const secretText = "conflict-webhook-secret"
const secretBytes = new TextEncoder().encode(secretText)

describe("pr conflict webhook", () => {
  it.effect("parses only conflicted pull_request events", () =>
    Effect.gen(function*() {
      const conflicted = yield* decodePrConflictEvent({ action: "synchronize", pull_request: { number: 7, head: { ref: "feature/conflict-demo", sha: "abc123" }, base: { ref: "develop", sha: "def456" }, mergeable: false, mergeable_state: "dirty" } })
      expect(conflicted?.pullNumber).toBe(7)
      const clean = yield* decodePrConflictEvent({ action: "synchronize", pull_request: { number: 7, head: { ref: "feature/conflict-demo", sha: "abc123" }, base: { ref: "develop", sha: "def456" }, mergeable: true, mergeable_state: "clean" } })
      expect(clean).toBeNull()
      const ignored = yield* decodePrConflictEvent({ action: "closed", pull_request: { number: 7, head: { ref: "feature/conflict-demo", sha: "abc123" }, base: { ref: "develop", sha: "def456" }, mergeable: false, mergeable_state: "dirty" } })
      expect(ignored).toBeNull()
    }))
  it.effect("verifies signatures without leaking secrets", () =>
    Effect.gen(function*() {
      const raw = new TextEncoder().encode("{\"action\":\"synchronize\"}")
      const hex = createHmac("sha256", secretBytes).update(raw).digest("hex")
      expect(verifyPrConflictSignature(secretBytes, raw, `sha256=${hex}`)).toBe(true)
      expect(verifyPrConflictSignature(secretBytes, raw, "sha256=00")).toBe(false)
    }))
})
