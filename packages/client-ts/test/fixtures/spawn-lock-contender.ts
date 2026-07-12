import { Effect } from "effect"
import { existsSync, writeFileSync } from "node:fs"
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
while (!existsSync(startPath)) await Bun.sleep(1)

const lease = await Effect.runPromise(acquireSpawnLock(lockPath))
writeFileSync(
  resultPath,
  JSON.stringify(lease === undefined
    ? { status: "contended" }
    : { status: "acquired", pid: lease.pid, token: lease.token })
)

if (lease !== undefined) {
  while (!existsSync(releasePath)) await Bun.sleep(1)
  await Effect.runPromise(releaseSpawnLock(lease))
}
