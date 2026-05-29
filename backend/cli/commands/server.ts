import { Command } from "effect/unstable/cli"
import { Effect } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/composition/app" // I-1 permitted exception (this file only)

const dbPath = () =>
  process.env.YODEA_DB ??
  join(process.env.YODEA_HOME ?? join(homedir(), ".yodea"), "events.db")

// Force the OS process to exit once `runServer` completes its clean I-4 shutdown.
//
// WHY: the default `runMain` teardown only calls `process.exit` on a received
// signal or a non-zero exit; on a clean self-shutdown (exit 0, no signal) it
// relies on the event loop draining. But `runServer` deliberately ABANDONS Bun's
// graceful `server.stop()` after a grace window (to avoid the zero-connection
// teardown deadlock), leaving a live Bun server handle in the loop. The loop
// therefore never drains and the process would hang forever in epoll_wait,
// leaking a ~100MB zombie that holds the SQLite WAL open — one per auto-spawn —
// defeating I-4. By the time this runs the endpoint file is removed and the port
// released, so exiting leaks nothing observable. This lives at the process entry
// point (not in `runServer`) so in-process callers — the e2e tests — can run the
// server effect to completion without `process.exit` killing the test runner.
export const serverCommand = Command.make("server", {}, () =>
  runServer({ dbPath: dbPath(), port: 51789 }).pipe(
    Effect.ensuring(Effect.sync(() => process.exit(0)))
  )
)
