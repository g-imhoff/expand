import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { createHmac } from "node:crypto"
import { createServer, request as httpRequest } from "node:http"
import { Cause, Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { SqlClient } from "effect/sql/SqlClient"
import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { CustomWebhookCredentialSlot } from "@expand/contracts/automation/custom"
import { buildGithubClassificationProcess, githubTemplateReference, makeGithubExtension } from "@expand/contracts/automation/github"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { GithubWebhookCredentialSlot } from "../../automation/github-webhook.js"
import { encodeJson } from "../../automation/persistence-models.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { customWebhookRouteHandler, githubWebhookRouteHandler, webhookBodyLimitBytes } from "../../transport/http-server.js"
import { makeSampleExtension, sampleRoutine } from "../fixtures/automation-sample-extension.js"

const scope = { ownerId: "body-limit-owner", projectId: "body-limit-project" }
const secret = "body-limit-webhook-secret"
const classification = { categories: ["bug"], labels: { bug: "type: bug" }, notifications: { onMatch: false, onNoMatch: false } }

const fixture = Effect.gen(function* () {
  const registry = new AutomationRegistry()
  yield* registry.register(makeGithubExtension().extension)
  yield* registry.register(makeSampleExtension().extension)
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const configuration = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(database))
  const credentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(configuration))
  const live = Layer.mergeAll(ExecutionRepositoryLayer, RoutineServiceLayer(registry)).pipe(Layer.provideMerge(credentials))
  const context = yield* Layer.build(live)
  const executions = Context.get(context, ExecutionRepository)
  const ingest = vi.fn(executions.ingest)
  const services = {
    configurations: Context.get(context, ConfigurationRepository),
    credentials: Context.get(context, CredentialRepository),
    executions: { ...executions, ingest },
    sql: Context.get(context, SqlClient),
  }
  const routines = Context.get(context, RoutineService)
  yield* services.credentials.putCredential(scope, "webhook-secret", new TextEncoder().encode(secret), 0)
  yield* services.credentials.putCredential(scope, "github-token", new TextEncoder().encode("github-token"), 0)
  yield* routines.create(scope, {
    routineId: "triage",
    template: githubTemplateReference,
    configuration: classification,
    integrations: [{
      schemaVersion: 1, kind: "integration-configuration", id: "github",
      definition: { id: "github:integration", version: 1 }, configuration: { owner: "octo", repo: "hello" },
      credentials: {
        token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" },
        [GithubWebhookCredentialSlot]: { schemaVersion: 1, kind: "credential-reference", credentialId: "webhook-secret" },
      },
    }],
    process: yield* buildGithubClassificationProcess("github", classification),
  })
  yield* routines.create(scope, {
    routineId: "personal-mail", template: sampleRoutine.definition,
    configuration: { prefix: "Hello" }, process: sampleRoutine.process,
    integrations: [{
      schemaVersion: 1, kind: "integration-configuration", id: "mail",
      definition: { id: "sample:mail", version: 1 }, configuration: { mailbox: "inbox" },
      credentials: { [CustomWebhookCredentialSlot]: { schemaVersion: 1, kind: "credential-reference", credentialId: "webhook-secret" } },
    }],
  })
  const routes = Layer.effectDiscard(Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    yield* router.add("POST", "/webhooks/github", githubWebhookRouteHandler(services))
    yield* router.add("POST", "/webhooks/custom", customWebhookRouteHandler(services, registry))
  }))
  const transport = yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
  ))
  const address = Context.get(transport, HttpServer.HttpServer).address
  if (!NetAddress.isInetAddress(address)) return yield* Effect.fail("server did not bind an inet address")
  return { port: address.port, services, ingest }
})

type Route = "github" | "custom"

const rawOf = (route: Route, size?: number): Uint8Array => {
  const body = (padding: string) => route === "github"
    ? { action: "opened", repository: { name: "hello", owner: { login: "octo" } }, issue: { number: 42, title: "Body limit", body: padding } }
    : { routineId: "personal-mail", payload: { subject: padding, count: "2" } }
  const empty = new TextEncoder().encode(encodeJson(body("")))
  return new TextEncoder().encode(encodeJson(body("x".repeat(size === undefined ? 8 : size - empty.byteLength))))
}

const headersFor = (route: Route, deliveryId: string, raw: Uint8Array, signingSecret = secret): Record<string, string> => {
  const signature = `sha256=${createHmac("sha256", signingSecret).update(raw).digest("hex")}`
  return route === "github"
    ? { "x-github-delivery": deliveryId, "x-github-event": "issues", "x-hub-signature-256": signature }
    : {
      "x-custom-owner": scope.ownerId, "x-custom-project": scope.projectId,
      "x-custom-integration": "mail", "x-custom-delivery": deliveryId, "x-custom-signature": signature,
    }
}

const post = (port: number, route: Route, headers: Record<string, string>, raw: Uint8Array, chunked: boolean, finish = true) =>
  Effect.callback<{ status: number; text: string; connection: string | undefined }, Cause.UnknownError>((resume) => {
    const request = httpRequest({
      host: "127.0.0.1", port, path: `/webhooks/${route}`, method: "POST",
      headers: { ...headers, "content-type": "application/json", ...(chunked ? {} : { "content-length": String(raw.byteLength) }) },
    }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("error", (error) => resume(Effect.fail(new Cause.UnknownError(error))))
      response.on("end", () => {
        resume(Effect.succeed({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString(), connection: response.headers.connection }))
        request.destroy()
      })
    })
    request.on("error", (error) => resume(Effect.fail(new Cause.UnknownError(error))))
    request.flushHeaders()
    if (finish || chunked) {
      for (let offset = 0; offset < raw.byteLength; offset += 65536) request.write(raw.subarray(offset, offset + 65536))
    }
    if (finish) request.end()
    return Effect.sync(() => request.destroy())
  }).pipe(Effect.timeoutOrElse({
    duration: "2 seconds",
    orElse: () => Effect.fail(new Cause.UnknownError("webhook response timed out before the request body ended")),
  }))

const expectEmpty = (services: Effect.Success<typeof fixture>["services"], ingest: Effect.Success<typeof fixture>["ingest"]) =>
  Effect.gen(function* () {
    expect(ingest).not.toHaveBeenCalled()
    const deliveries = yield* services.sql`SELECT id FROM automation_deliveries`
    const jobs = yield* services.sql`SELECT id FROM automation_jobs`
    const runs = yield* services.sql`SELECT id FROM automation_runs`
    expect(deliveries).toEqual([])
    expect(jobs).toEqual([])
    expect(runs).toEqual([])
  })

for (const route of ["github", "custom"] as const) {
  describe(`${route} webhook body limit`, () => {
    it.live("rejects an oversized declared body before reading it or ingesting a delivery", () =>
      Effect.gen(function* () {
        const { port, services, ingest } = yield* fixture
        const raw = rawOf(route, webhookBodyLimitBytes + 1)
        const response = yield* post(port, route, headersFor(route, "declared-large", raw), raw, false, false)
        expect(response.status).toBe(413)
        expect(response.connection).toBe("close")
        const unsigned = yield* post(port, route, {}, raw, false, false)
        expect(unsigned.status).toBe(413)
        yield* expectEmpty(services, ingest)
      }).pipe(Effect.scoped),
    )

    it.live("rejects an unfinished oversized chunked body before ingesting a delivery", () =>
      Effect.gen(function* () {
        const { port, services, ingest } = yield* fixture
        const raw = rawOf(route, webhookBodyLimitBytes + 1)
        const response = yield* post(port, route, headersFor(route, "chunked-large", raw), raw, true, false)
        expect(response.status).toBe(413)
        expect(response.connection).toBe("close")
        const unsigned = yield* post(port, route, {}, raw, true, false)
        expect(unsigned.status).toBe(413)
        yield* expectEmpty(services, ingest)
      }).pipe(Effect.scoped),
    )

    it.live("accepts signed declared and chunked bodies up to the limit and preserves signature rejection", () =>
      Effect.gen(function* () {
        const { port, services, ingest } = yield* fixture
        const raw = rawOf(route, webhookBodyLimitBytes - 1)
        for (const chunked of [false, true]) {
          const deliveryId = `valid-${String(chunked)}`
          const response = yield* post(port, route, headersFor(route, deliveryId, raw), raw, chunked)
          expect(response.status).toBe(200)
          expect(response.text).toContain('"accepted":true')
          expect(response.text).toContain(deliveryId)
        }
        const atLimit = rawOf(route, webhookBodyLimitBytes)
        const boundary = yield* post(port, route, headersFor(route, "at-limit", atLimit), atLimit, true)
        expect(boundary.status).toBe(200)
        expect(boundary.text).toContain('"accepted":true')
        const bad = yield* post(port, route, headersFor(route, "bad-signature", raw, "wrong-secret"), raw, true)
        expect(bad.status).toBe(401)
        expect(bad.text).toBe("")
        expect(ingest).toHaveBeenCalledTimes(3)
        const runs = yield* services.executions.listRuns(scope, { limit: 10 })
        expect(runs.items).toHaveLength(3)
      }).pipe(Effect.scoped),
    )
  })
}
