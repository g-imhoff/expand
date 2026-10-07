import { Effect } from "effect"
import { startGmailPolling, DefaultGmailPollingOptions } from "./gmail-polling.js"
import type { GmailPollingOptions } from "./gmail-polling.js"
import { startAutomationWorker, DefaultAutomationWorkerOptions } from "./worker.js"
import type { AutomationWorkerEnvironment, AutomationWorkerOptions } from "./worker.js"

export const startAutomationProcessing = Effect.fn("AutomationRuntime.start")(function*(
  environment: AutomationWorkerEnvironment,
  workerOptions: AutomationWorkerOptions = DefaultAutomationWorkerOptions,
  gmailOptions: GmailPollingOptions = DefaultGmailPollingOptions
) {
  yield* Effect.forkScoped(startGmailPolling(environment, gmailOptions))
  yield* startAutomationWorker(environment, workerOptions)
}, Effect.scoped)
