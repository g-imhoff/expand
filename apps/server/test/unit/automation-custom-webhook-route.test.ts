import { describe, expect, it } from "vitest"
import {
  customWebhookRequestInput,
  customWebhookResult,
} from "../../transport/http-server.js"

describe("custom webhook route mapping", () => {
  it("reads the caller key from headers and passes the raw body through", () => {
    const raw = new TextEncoder().encode("raw-body")
    const input = customWebhookRequestInput(
      {
        "x-custom-owner": "owner",
        "x-custom-project": "project",
        "x-custom-integration": "mail",
        "x-custom-delivery": "key-1",
        "x-custom-signature": "sha256=abc",
      },
      raw,
    )
    expect(input).toEqual({
      ownerId: "owner",
      projectId: "project",
      integrationId: "mail",
      deliveryId: "key-1",
      signature: "sha256=abc",
      raw,
    })
  })

  it("defaults missing headers to empty strings and a missing signature to undefined", () => {
    const raw = new Uint8Array()
    const input = customWebhookRequestInput({}, raw)
    expect(input.ownerId).toBe("")
    expect(input.projectId).toBe("")
    expect(input.integrationId).toBe("")
    expect(input.deliveryId).toBe("")
    expect(input.signature).toBeUndefined()
  })

  it("maps a 401 outcome to an empty body", () => {
    expect(customWebhookResult({ status: 401, accepted: false })).toEqual({ status: 401, body: null })
  })

  it("maps 400 outcomes to the failing field without extra detail", () => {
    const result = customWebhookResult({ status: 400, accepted: false, field: "payload", message: "payload is not usable" })
    expect(result.status).toBe(400)
    expect(result.body).toContain("payload")
  })

  it("maps 404 and 409 outcomes to their messages", () => {
    expect(customWebhookResult({ status: 404, accepted: false, message: "Routine does not exist" }).status).toBe(404)
    expect(customWebhookResult({ status: 409, accepted: false, message: "Delivery key was already used with different input" }).status).toBe(409)
  })

  it("maps accepted and ignored outcomes to 200 with matching accepted flags", () => {
    const accepted = customWebhookResult({ status: 200, accepted: true, deliveryId: "key-1", jobIds: ["job-1"], runIds: ["run-1"] })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toContain("key-1")
    const ignored = customWebhookResult({ status: 200, accepted: false })
    expect(ignored).toEqual({ status: 200, body: '{"accepted":false}' })
  })
})
