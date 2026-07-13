import { Effect } from "effect"
import { existsSync, renameSync, writeFileSync } from "node:fs"
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

const publishResult = (result: unknown) => {
  const temporaryPath = `${resultPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(result))
  renameSync(temporaryPath, resultPath)
}

try {
  const lease = await Effect.runPromise(acquireStateRootLock(root))
  publishResult({ status: "acquired", pid: lease.pid, token: lease.token })
  while (!existsSync(releasePath)) await setTimeout(1)
  await Effect.runPromise(releaseStateRootLock(lease))
} catch (error) {
  publishResult({
    status: "rejected",
    reason: error instanceof Error ? error.message : String(error)
  })
}
