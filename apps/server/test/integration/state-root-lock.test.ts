import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  acquireStateRootLock,
  releaseStateRootLock,
  StateRootLockError
} from "@expand/server/state-root-lock"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-state-root-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("state root ownership (I-2)", () => {
  it("rejects a second live owner for the same state root", async () => {
    const first = await Effect.runPromise(acquireStateRootLock(dir))
    const error = await Effect.runPromise(Effect.flip(acquireStateRootLock(dir)))

    expect(error).toBeInstanceOf(StateRootLockError)
    expect(error).toMatchObject({ dataDir: dir })

    await Effect.runPromise(releaseStateRootLock(first))
  })

  it("allows live owners for different state roots", async () => {
    const otherDir = join(dir, "other")
    const first = await Effect.runPromise(acquireStateRootLock(dir))
    const second = await Effect.runPromise(acquireStateRootLock(otherDir))

    expect(first.path).toBe(join(dir, "backend.lock"))
    expect(second.path).toBe(join(otherDir, "backend.lock"))
    expect(statSync(second.path).mode & 0o777).toBe(0o600)
    expect(statSync(otherDir).mode & 0o777).toBe(0o700)

    await Effect.runPromise(releaseStateRootLock(first))
    await Effect.runPromise(releaseStateRootLock(second))
  })

  it("restricts an existing permissive state root to owner access", async () => {
    chmodSync(dir, 0o777)

    const lease = await Effect.runPromise(acquireStateRootLock(dir))

    expect(statSync(dir).mode & 0o777).toBe(0o700)

    await Effect.runPromise(releaseStateRootLock(lease))
  })

  it("elects exactly one real process for a fresh state root", async () => {
    const results = await runContenders(join(dir, "fresh"), 64)

    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1)
  }, 30_000)

  it("fails closed instead of unlinking an incomplete canonical lock", async () => {
    const lockPath = join(dir, "backend.lock")
    writeFileSync(lockPath, "")

    const result = await Effect.runPromise(Effect.result(acquireStateRootLock(dir)))

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "StateRootLockError" }
    })
    expect(readFileSync(lockPath, "utf8")).toBe("")
  })

  it("recovers a lock whose owner is no longer alive", async () => {
    const lockPath = join(dir, "backend.lock")
    const staleToken = randomUUID()
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: staleToken }))

    const lease = await Effect.runPromise(acquireStateRootLock(dir))

    expect(lease.pid).toBe(process.pid)
    expect(lease.token).not.toBe(staleToken)

    await Effect.runPromise(releaseStateRootLock(lease))
  })

  it("elects exactly one real process during concurrent stale recovery", async () => {
    const root = join(dir, "stale")
    mkdirSync(root)
    writeFileSync(join(root, "backend.lock"), JSON.stringify({
      pid: 2_147_483_647,
      token: randomUUID()
    }))

    const results = await runContenders(root, 64)

    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1)
  }, 30_000)

  it("does not remove a replacement owner's lock", async () => {
    const lease = await Effect.runPromise(acquireStateRootLock(dir))
    const replacement = { pid: process.pid, token: randomUUID() }
    writeFileSync(lease.path, JSON.stringify(replacement))

    await Effect.runPromise(releaseStateRootLock(lease))

    expect(JSON.parse(readFileSync(lease.path, "utf8"))).toEqual(replacement)
  })
})

interface ContenderResult {
  readonly status: "acquired" | "rejected"
  readonly pid?: number
  readonly token?: string
  readonly reason?: string
}

interface RunningContender {
  readonly exit: Promise<void>
  readonly stderr: () => string
}

const contenderPath = fileURLToPath(new URL("../fixtures/state-root-lock-contender.ts", import.meta.url))

const runContenders = async (root: string, count: number): Promise<ReadonlyArray<ContenderResult>> => {
  const coordinationDir = join(dir, `coordination-${randomUUID()}`)
  const startPath = join(coordinationDir, "start")
  const releasePath = join(coordinationDir, "release")
  mkdirSync(coordinationDir)

  const contenders = Array.from({ length: count }, (_, index) => {
    const readyPath = join(coordinationDir, `ready-${index}`)
    const resultPath = join(coordinationDir, `result-${index}`)
    const child = spawn(process.execPath, [contenderPath, root, readyPath, startPath, releasePath, resultPath], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`contender exited with code ${String(code)} signal ${String(signal)}: ${stderr}`))
      })
    })
    return { readyPath, resultPath, running: { exit, stderr: () => stderr } }
  })

  try {
    await waitUntil(() => contenders.every(({ readyPath }) => existsSync(readyPath)), contenders)
    writeFileSync(startPath, "start")
    await waitUntil(() => contenders.every(({ resultPath }) => existsSync(resultPath)), contenders)
    return contenders.map(({ resultPath }) => JSON.parse(readFileSync(resultPath, "utf8")) as ContenderResult)
  } finally {
    writeFileSync(releasePath, "release")
    await Promise.all(contenders.map(({ running }) => running.exit))
  }
}

const waitUntil = async (
  predicate: () => boolean,
  contenders: ReadonlyArray<{ readonly running: RunningContender }>
): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`contenders did not coordinate: ${contenders.map(({ running }) => running.stderr()).join("\n")}`)
    }
    await Bun.sleep(5)
  }
}
