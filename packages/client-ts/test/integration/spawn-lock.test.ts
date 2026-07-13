import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer } from "effect"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { BackendUnavailable } from "../../errors"
import { findOrSpawnBackend } from "../../spawn"
import { acquireSpawnLock, releaseSpawnLock } from "../../spawn-lock"
import { makeNodeAdapter } from "../../adapters/node"

let dir: string
const nodeAdapter = makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-client-lock-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("client spawn lock", () => {
  it("elects exactly one of 64 real processes for a fresh lock", async () => {
    const lockPath = join(dir, "fresh", "server.json.lock")
    const results = await runContenders(lockPath, 64)

    expect(results.filter(({ status }) => status === "acquired")).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(false)
  }, 30_000)

  it("elects exactly one of 64 real processes for a valid dead current owner", async () => {
    const lockPath = join(dir, "stale", "server.json.lock")
    mkdirSync(join(dir, "stale"))
    writeFileSync(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: randomUUID()
    }))

    const results = await runContenders(lockPath, 64)

    expect(results.filter(({ status }) => status === "acquired")).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(false)
  }, 30_000)

  it("never publishes an incomplete canonical record", async () => {
    const lockPath = join(dir, "publication", "server.json.lock")
    let candidatePath: string | undefined
    let candidateRecord: unknown

    const lease = await runAcquire(lockPath, {
      beforePublish: (path) => {
        candidatePath = path
        expect(existsSync(lockPath)).toBe(false)
        expect(statSync(path).mode & 0o777).toBe(0o600)
        candidateRecord = JSON.parse(readFileSync(path, "utf8"))
        expect(isCurrentRecord(candidateRecord)).toBe(true)
      }
    })

    expect(lease).toBeDefined()
    expect(candidatePath).toBeDefined()
    expect(candidateRecord).toEqual({
      pid: lease?.pid,
      startedAt: lease?.startedAt,
      token: lease?.token
    })
    const canonicalRecord = JSON.parse(readFileSync(lockPath, "utf8"))
    expect(isCurrentRecord(canonicalRecord)).toBe(true)
    expect(canonicalRecord).toEqual({
      pid: lease?.pid,
      startedAt: lease?.startedAt,
      token: lease?.token
    })
    if (candidatePath !== undefined) expect(existsSync(candidatePath)).toBe(false)
    if (lease !== undefined) await Effect.runPromise(releaseSpawnLock(lease))
  })

  it("does not let a delayed stale observer unlink a replacement", async () => {
    const lockPath = join(dir, "delayed.lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: randomUUID()
    }))
    let replacement = undefined as Awaited<ReturnType<typeof runAcquire>>

    const delayed = await runAcquire(lockPath, {
      afterObservation: () => {
        rmSync(lockPath)
        replacement = Effect.runSync(acquireSpawnLock(lockPath))
      }
    })

    expect(delayed).toBeUndefined()
    expect(replacement).toBeDefined()
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ token: replacement?.token })
    if (replacement !== undefined) await Effect.runPromise(releaseSpawnLock(replacement))
  })

  it("preserves a replacement when an old owner releases", async () => {
    const lockPath = join(dir, "release.lock")
    const oldLease = await runAcquire(lockPath)
    expect(oldLease).toBeDefined()
    rmSync(lockPath)
    const replacement = await runAcquire(lockPath)
    expect(replacement).toBeDefined()
    const replacementStat = statSync(lockPath)

    if (oldLease !== undefined) await Effect.runPromise(releaseSpawnLock(oldLease))

    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ token: replacement?.token })
    expect(statSync(lockPath)).toMatchObject({ dev: replacementStat.dev, ino: replacementStat.ino })
    if (replacement !== undefined) await Effect.runPromise(releaseSpawnLock(replacement))
  })

  it("fails closed when the canonical owner is replaced during reclaim", async () => {
    const lockPath = join(dir, "reclaim.lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: randomUUID()
    }))
    let replacement = undefined as Awaited<ReturnType<typeof runAcquire>>

    const contender = await runAcquire(lockPath, {
      afterClaim: () => {
        rmSync(lockPath)
        replacement = Effect.runSync(acquireSpawnLock(lockPath))
      }
    })

    expect(contender).toBeUndefined()
    expect(replacement).toBeDefined()
    const replacementStat = statSync(lockPath)
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ token: replacement?.token })
    expect(statSync(lockPath)).toMatchObject({ dev: replacementStat.dev, ino: replacementStat.ino })
    if (replacement !== undefined) await Effect.runPromise(releaseSpawnLock(replacement))
  })

  it("leaves malformed ownership evidence untouched", async () => {
    const lockPath = join(dir, "malformed.lock")
    writeFileSync(lockPath, "{")
    const malformedStat = statSync(lockPath)

    expect(await runAcquire(lockPath)).toBeUndefined()
    expect(readFileSync(lockPath, "utf8")).toBe("{")
    expect(statSync(lockPath)).toMatchObject({ dev: malformedStat.dev, ino: malformedStat.ino })
  })

  it("does not steal a live current owner because of age", async () => {
    const lockPath = join(dir, "live.lock")
    const record = { pid: process.pid, startedAt: 1, token: randomUUID() }
    writeFileSync(lockPath, JSON.stringify(record))

    expect(await runAcquire(lockPath)).toBeUndefined()
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(record)
  })

  it("treats EPERM from PID probing as a live owner", async () => {
    const lockPath = join(dir, "eperm.lock")
    const record = { pid: 424_242, startedAt: 1, token: randomUUID() }
    writeFileSync(lockPath, JSON.stringify(record))

    expect(await runAcquire(lockPath, {
      probeProcess: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" })
      }
    })).toBeUndefined()
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(record)
  })

  it("recovers a dead tokenless legacy owner", async () => {
    const lockPath = join(dir, "legacy-dead.lock")
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }))

    const lease = await runAcquire(lockPath)

    expect(lease).toBeDefined()
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ token: lease?.token })
    if (lease !== undefined) await Effect.runPromise(releaseSpawnLock(lease))
  })

  it("does not steal a live tokenless legacy owner", async () => {
    const lockPath = join(dir, "legacy-live.lock")
    const record = { pid: process.pid, startedAt: 1 }
    writeFileSync(lockPath, JSON.stringify(record))

    expect(await runAcquire(lockPath)).toBeUndefined()
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(record)
  })

  it("cleans its lease after success", async () => {
    const context = makeTestAppContext(join(dir, "success"))
    mkdirSync(context.paths.dataDir)
    const endpoint = liveEndpoint("success")
    const adapter = {
      ...nodeAdapter,
      spawnBackend: () => Effect.sync(() => writeFileSync(context.paths.endpointFile, JSON.stringify(endpoint)))
    }

    await Effect.runPromise(
      findOrSpawnBackend(adapter).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide(Layer.succeed(AppContext, context))
      )
    )

    expect(existsSync(context.paths.spawnLockFile)).toBe(false)
    expect(lockArtifacts(context.paths.spawnLockFile)).toEqual([])
  })

  it("cleans its lease after a spawn error", async () => {
    const context = makeTestAppContext(join(dir, "error"))
    mkdirSync(context.paths.dataDir)
    const adapter = {
      ...nodeAdapter,
      spawnBackend: () => Effect.fail(new BackendUnavailable({ reason: "expected" }))
    }

    await Effect.runPromise(
      Effect.result(findOrSpawnBackend(adapter)).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide(Layer.succeed(AppContext, context))
      )
    )

    expect(existsSync(context.paths.spawnLockFile)).toBe(false)
    expect(lockArtifacts(context.paths.spawnLockFile)).toEqual([])
  })

  it("cleans its lease after interruption", async () => {
    const context = makeTestAppContext(join(dir, "interruption"))
    mkdirSync(context.paths.dataDir)
    const adapter = {
      ...nodeAdapter,
      spawnBackend: () => Effect.never
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            findOrSpawnBackend(adapter).pipe(
              Effect.provide(NodeServices.layer),
              Effect.provide(Layer.succeed(AppContext, context))
            )
          )
          yield* Effect.promise(() => waitUntil(() => existsSync(context.paths.spawnLockFile)))
          yield* Fiber.interrupt(fiber)
        })
      )
    )

    expect(existsSync(context.paths.spawnLockFile)).toBe(false)
    expect(lockArtifacts(context.paths.spawnLockFile)).toEqual([])
  })

  it("keeps different lock paths independent and secures their directories", async () => {
    const leftPath = join(dir, "left", "server.json.lock")
    const rightPath = join(dir, "right", "server.json.lock")
    const [left, right] = await Promise.all([runAcquire(leftPath), runAcquire(rightPath)])

    expect(left).toBeDefined()
    expect(right).toBeDefined()
    expect(statSync(join(dir, "left")).mode & 0o777).toBe(0o700)
    expect(statSync(leftPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "right")).mode & 0o777).toBe(0o700)
    expect(statSync(rightPath).mode & 0o777).toBe(0o600)
    if (left !== undefined) await Effect.runPromise(releaseSpawnLock(left))
    if (right !== undefined) await Effect.runPromise(releaseSpawnLock(right))
  })
})

interface ContenderResult {
  readonly status: "acquired" | "contended"
  readonly pid?: number
  readonly token?: string
}

interface AcquireOptions {
  readonly afterClaim?: () => void
  readonly afterObservation?: () => void
  readonly beforePublish?: (candidatePath: string) => void
  readonly probeProcess?: (pid: number) => void
}

const contenderPath = fileURLToPath(new URL("../fixtures/spawn-lock-contender.ts", import.meta.url))

const runAcquire = (lockPath: string, options: AcquireOptions = {}) =>
  Effect.runPromise(acquireSpawnLock(lockPath, options))

const runContenders = async (
  lockPath: string,
  count: number
): Promise<ReadonlyArray<ContenderResult>> => {
  const coordinationDir = join(dir, `coordination-${randomUUID()}`)
  const startPath = join(coordinationDir, "start")
  const releasePath = join(coordinationDir, "release")
  mkdirSync(coordinationDir)
  const processes = Array.from({ length: count }, (_, index) => {
    const readyPath = join(coordinationDir, `ready-${index}`)
    const resultPath = join(coordinationDir, `result-${index}`)
    const child = spawn(
      process.execPath,
      ["--import", "tsx", contenderPath, lockPath, readyPath, startPath, releasePath, resultPath],
      { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), stdio: ["ignore", "ignore", "pipe"] }
    )
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`spawn-lock contender failed: ${String(code)} ${String(signal)} ${stderr}`))
      })
    })
    return { readyPath, resultPath, exit, stderr: () => stderr }
  })

  try {
    await waitUntil(() => processes.every(({ readyPath }) => existsSync(readyPath)), processes)
    writeFileSync(startPath, "start")
    await waitUntil(() => processes.every(({ resultPath }) => existsSync(resultPath)), processes)
    return processes.map(({ resultPath }) => JSON.parse(readFileSync(resultPath, "utf8")) as ContenderResult)
  } finally {
    writeFileSync(releasePath, "release")
    await Promise.all(processes.map(({ exit }) => exit))
  }
}

const waitUntil = async (
  predicate: () => boolean,
  processes: ReadonlyArray<{ readonly stderr: () => string }> = []
): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`coordination timed out: ${processes.map(({ stderr }) => stderr()).join("\n")}`)
    }
    await setTimeout(2)
  }
}

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const isCurrentRecord = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).sort().join(",") === "pid,startedAt,token" &&
    Number.isSafeInteger(candidate.pid) && (candidate.pid as number) > 0 &&
    Number.isSafeInteger(candidate.startedAt) && (candidate.startedAt as number) >= 0 &&
    typeof candidate.token === "string" && TOKEN_PATTERN.test(candidate.token)
}

const liveEndpoint = (token: string) => ({
  url: "ws://127.0.0.1:51991/rpc",
  token,
  pid: process.pid,
  protocolVersion: PROTOCOL_VERSION
})

const lockArtifacts = (lockPath: string): ReadonlyArray<string> => {
  const parent = dirname(lockPath)
  const prefix = lockPath.slice(parent.length + 1)
  return readdirSync(parent).filter((entry) => entry.startsWith(`${prefix}.`))
}

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve: (...paths) => paths[paths.length - 1] ?? "" },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )
