import { describe, expect } from "vitest"
import { Effect, Schema } from "effect"
import { it } from "@effect/vitest"
import {
  boundLogsSnippet,
  decodePipelineWebhookText,
  isBranchAllowed,
  isProtectedBranch,
  pipelineExternalId,
  pipelineRepairKey,
  pipelineStoredDeliveryId,
  shouldAttemptRepair,
  toPipelinePayload
} from "../../automation/pipeline-repair.js"
import { PipelineWorkflowPayload } from "@expand/contracts/automation/pipeline"

const encodeText = (value: unknown): Uint8Array => {
  const text = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value)
  return new TextEncoder().encode(text)
}

describe("pipeline repair policy", () => {
  it.effect("enforces protected branches and allowlists with bounded retries", () =>
    Effect.gen(function*() {
      expect(isProtectedBranch("develop", ["develop", "master", "main"])).toBe(true)
      expect(isProtectedBranch("feature/repair-sandbox", ["develop", "master", "main"])).toBe(false)
      expect(isBranchAllowed("feature/repair-sandbox", ["feature/repair-sandbox"])).toBe(true)
      expect(isBranchAllowed("other", ["feature/repair-sandbox"])).toBe(false)
      expect(isBranchAllowed("anything", undefined)).toBe(true)
      expect(shouldAttemptRepair(0, 2)).toBe(true)
      expect(shouldAttemptRepair(1, 2)).toBe(true)
      expect(shouldAttemptRepair(2, 2)).toBe(false)
      expect(shouldAttemptRepair(0, 1)).toBe(true)
      expect(pipelineRepairKey("octo", "hello", 42)).toBe("octo/hello#42")
      expect(boundLogsSnippet("abc")).toBe("abc")
      expect(boundLogsSnippet("x".repeat(5000)).length).toBe(4000)
    }))

  it.effect("decodes workflow_run webhooks and keeps delivery keys stable", () =>
    Effect.gen(function*() {
      const failed = {
        action: "completed",
        workflow_run: {
          id: 42,
          head_branch: "feature/repair-sandbox",
          head_sha: "abc123",
          conclusion: "failure",
          name: "ci"
        },
        repository: { name: "hello", owner: { login: "octo" } }
      }
      const event = yield* decodePipelineWebhookText(encodeText(failed))
      expect(event.workflow_run.id).toBe(42)
      const payload = toPipelinePayload(event)
      expect(payload !== null).toBe(true)
      const proved = yield* Schema.decodeUnknownEffect(PipelineWorkflowPayload, { onExcessProperty: "error" })(payload)
      expect(proved.runId).toBe(42)
      expect(pipelineExternalId(proved)).toBe("octo/hello#42")
      expect(pipelineStoredDeliveryId("delivery-1", "github")).toBe("delivery-1:github")
      const success = {
        action: "completed",
        workflow_run: {
          id: 43,
          head_branch: "feature/repair-sandbox",
          head_sha: "abc123",
          conclusion: "success",
          name: "ci"
        },
        repository: { name: "hello", owner: { login: "octo" } }
      }
      const successEvent = yield* decodePipelineWebhookText(encodeText(success))
      expect(toPipelinePayload(successEvent)).toBe(null)
      const bad = yield* Effect.exit(decodePipelineWebhookText(encodeText({ action: "completed" })))
      expect(bad._tag).toBe("Failure")
    }))
})
