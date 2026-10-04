import { useState } from "react"
import type { PersonalScope } from "@expand/contracts/automation"
import { Input } from "@expand/desktop/renderer/components/ui/input"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import {
  useCredentialStatuses,
  useZenConnect
} from "@expand/desktop/renderer/features/automations/data/use-integrations"
import {
  describeAutomationError,
  describeZenStatus,
  zenCredentialId
} from "@expand/desktop/renderer/features/automations/model/integration-messages"

export const ZenConnection = ({ scope }: { readonly scope: PersonalScope }) => {
  const credentials = useCredentialStatuses(scope)
  const connect = useZenConnect(scope)
  const [apiKey, setApiKey] = useState("")
  const [tested, setTested] = useState(false)
  const unavailable = credentials.unavailable || connect.unavailable
  const keyConfigured = credentials.credentials?.some(
    (credential) => credential.credentialId === zenCredentialId && credential.configured
  ) ?? false
  const canSave = !unavailable && !connect.isConnectPending && apiKey.length > 0

  const save = () => {
    connect.resetConnect()
    setTested(false)
    connect.connect(apiKey, {
      onSuccess: () => {
        setApiKey("")
        credentials.retry()
      }
    })
  }

  const test = () => {
    setTested(false)
    credentials.retry()
    setTested(true)
  }

  return (
    <section aria-labelledby="zen-connection-heading">
      <h2 id="zen-connection-heading" className="text-lg font-semibold">Zen</h2>
      <p className="mt-2 text-sm text-muted-foreground">Save a Zen API key so routines can classify issues. This is the settings path for the key.</p>
      {unavailable ? (
        <p className="mt-2 text-sm text-muted-foreground">Automation services are unavailable in this session.</p>
      ) : (
        <>
          <div className="mt-3 flex max-w-md flex-col gap-3">
            <div>
              <Label htmlFor="zen-api-key">API key</Label>
              <Input
                id="zen-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={save} disabled={!canSave}>
              {connect.isConnectPending ? "Saving…" : "Save Zen API key"}
            </button>
            <button type="button" onClick={test} disabled={unavailable || credentials.isLoading}>
              {credentials.isLoading ? "Testing…" : "Test connection"}
            </button>
          </div>
          {credentials.isLoading && (
            <p className="mt-2 text-sm text-muted-foreground">Loading saved credentials…</p>
          )}
          {credentials.error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(credentials.error)}</p>
          )}
          {credentials.error !== undefined && (
            <button type="button" onClick={credentials.retry} className="mt-2 text-sm underline">Retry</button>
          )}
          {connect.connectError !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(connect.connectError)}</p>
          )}
          {!credentials.isLoading && credentials.error === undefined && tested && (
            <p role="status" className="mt-2 text-sm text-muted-foreground">{describeZenStatus(keyConfigured)}</p>
          )}
          {!tested && !credentials.isLoading && credentials.error === undefined && keyConfigured && (
            <p className="mt-2 text-sm text-muted-foreground">A Zen API key is saved for this project.</p>
          )}
          {!credentials.isLoading && credentials.error === undefined && !tested && !keyConfigured && (
            <p className="mt-2 text-sm text-muted-foreground">{describeZenStatus(false)}</p>
          )}
        </>
      )}
    </section>
  )
}
