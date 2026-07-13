import { Effect } from "effect"
import { existsSync, writeFileSync } from "node:fs"
import { setTimeout } from "node:timers/promises"
import {
  acquireStateRootLock,
  releaseStateRootLock
} from "@expand/server/state-root-lock"

const [root, readyPath, startPath, releasePath, resultPath] = process.argv.slice(2)

if (
  root === undefined ||
  readyPath === undefined ||
  startPath === undefined ||
  releasePath === undefined ||
  resultPath === undefined
) {
  throw new Error("missing contender arguments")
}

writeFileSync(readyPath, String(process.pid))

while (!existsSync(startPath)) await setTimeout(1)

try {
  const lease = await Effect.runPromise(acquireStateRootLock(root))
  writeFileSync(resultPath, JSON.stringify({ status: "acquired", pid: lease.pid, token: lease.token }))
  while (!existsSync(releasePath)) await setTimeout(1)
  await Effect.runPromise(releaseStateRootLock(lease))
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({
    status: "rejected",
    reason: error instanceof Error ? error.message : String(error)
  }))
}
