import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { getPullRequest, listOpenPulls } from "../../automation/github-pr-transport.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"

const withStub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
const token = "stub-github-token-for-tests-only"

describe("pr transport", () => {
  it.live("reads a conflicted pull and bounds the open list", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply((call) => {
      if (call.method === "GET" && call.path === "/repos/octo/hello/pulls/7") {
        return { status: 200, body: { number: 7, title: "conflicted", head: { ref: "feature/conflict-demo", sha: "abc123" }, base: { ref: "develop", sha: "def456" }, mergeable: false, mergeable_state: "dirty" } }
      }
      if (call.method === "GET" && call.path === "/repos/octo/hello/pulls") {
        return { status: 200, body: [{ number: 7, title: "conflicted", head: { ref: "feature/conflict-demo", sha: "abc123" }, base: { ref: "develop", sha: "def456" }, mergeable: false, mergeable_state: "dirty" }] }
      }
      return { status: 404, body: { message: "Not Found" } }
    })
    const pull = yield* getPullRequest("octo", "hello", 7, token, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(pull.number).toBe(7)
    expect(pull.headBranch).toBe("feature/conflict-demo")
    expect(pull.mergeable).toBe(false)
    const pulls = yield* listOpenPulls("octo", "hello", token, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(pulls.length).toBe(1)
    expect(pulls[0]!.number).toBe(7)
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
})
