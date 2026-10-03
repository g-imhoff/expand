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
  zenCredentialId
} from "@expand/desktop/renderer/features/automations/model/integration-messages"

export const ZenConnection = ({ scope }: { readonly scope: PersonalScope }) => {
  const credentials = useCredentialStatuses(scope)
  const connect = useZenConnect(scope)
  const [apiKey, setApiKey] = useState("")
  const unavailable = credentials.unavailable || connect.unavailable
  const keyConfigured = credentials.credentials?.some(
    (credential) => credential.credentialId === zenCredentialId && credential.configured
  ) ?? false
  const canSave = !unavailable && !connect.isConnectPending && apiKey.length > 0

  const save = () => {
    connect.resetConnect()
    connect.connect(apiKey, {
      onSuccess: () => {
        setApiKey("")
        credentials.retry()
      }
    })
  }

  return (
    <section aria-labelledby="zen-connection-heading">
      <h2 id="zen-connection-heading" className="text-lg font-semibold">Zen</h2>
      <p className="mt-2 text-sm text-muted-foreground">Save a Zen API key so routines can classify issues.</p>
      {unavailable ? (
        <p className="mt-2 text-sm text-muted-foreground">Automation services are unavailable in this session.</p>
      ) : (
        <>
          {keyConfigured && (
            <p className="mt-2 text-sm text-muted-foreground">A Zen API key is saved for this project.</p>
          )}
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
          <div className="mt-3">
            <button type="button" onClick={save} disabled={!canSave}>
              {connect.isConnectPending ? "Saving…" : "Save Zen API key"}
            </button>
          </div>
          {credentials.error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(credentials.error)}</p>
          )}
          {connect.connectError !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(connect.connectError)}</p>
          )}
        </>
      )}
    </section>
  )
}
