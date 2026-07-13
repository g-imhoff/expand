import { Effect } from "effect"
import { existsSync, renameSync, writeFileSync } from "node:fs"
import { setTimeout } from "node:timers/promises"
import { acquireSpawnLock, releaseSpawnLock } from "../../spawn-lock"

const [lockPath, readyPath, startPath, releasePath, resultPath] = process.argv.slice(2)

if (
  lockPath === undefined ||
  readyPath === undefined ||
  startPath === undefined ||
  releasePath === undefined ||
  resultPath === undefined
) {
  process.exit(2)
}

writeFileSync(readyPath, "ready")
while (!existsSync(startPath)) await setTimeout(1)

const publishResult = (result: unknown) => {
  const temporaryPath = `${resultPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(result))
  renameSync(temporaryPath, resultPath)
}

const lease = await Effect.runPromise(acquireSpawnLock(lockPath))
publishResult(
  lease === undefined
    ? { status: "contended" }
    : { status: "acquired", pid: lease.pid, token: lease.token }
)

if (lease !== undefined) {
  while (!existsSync(releasePath)) await setTimeout(1)
  await Effect.runPromise(releaseSpawnLock(lease))
}
