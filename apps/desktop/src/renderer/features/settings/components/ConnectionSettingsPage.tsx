import { useState } from "react"
import { Input } from "@expand/desktop/renderer/components/ui/input"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import type { ConnectionSettingsModel } from "@expand/desktop/renderer/features/settings/model/settings-contract"

export interface ConnectionSettingsPageProps {
  readonly model: ConnectionSettingsModel
  readonly onStartGithubOAuth: () => void
  readonly onPushToGh: () => void
  readonly onSaveZenKey: (key: string) => void
  readonly onTestConnection: (target: "github" | "zen") => void
  readonly onRetry: () => void
}

export const ConnectionSettingsPage = ({
  model,
  onStartGithubOAuth,
  onPushToGh,
  onSaveZenKey,
  onTestConnection,
  onRetry
}: ConnectionSettingsPageProps) => {
  const [zenKey, setZenKey] = useState("")
  const missingScopes = model.github.scopes.filter((scope) => !scope.granted)

  return (
    <section aria-labelledby="connection-settings-heading" className="mx-auto w-full min-w-0 max-w-3xl px-6 py-8">
      <h1 id="connection-settings-heading" className="text-2xl font-semibold">Settings</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Connections live here. Secrets are write-only: enter a value, save it, and read the status. Saved values are never shown again.
      </p>
      {model.status === "loading" ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading connections…</p>
      ) : model.status === "error" ? (
        <div className="mt-6">
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            {model.error ?? "Connections could not be loaded."}{" "}
            <button type="button" onClick={onRetry} className="underline">Retry</button>
          </p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-8">
          <section aria-labelledby="settings-github-heading" className="rounded-md border px-4 py-4">
            <h2 id="settings-github-heading" className="text-lg font-semibold">GitHub</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              OAuth once here. The app holds one shared token for every device. No pasted tokens.
            </p>
            <p role="status" className="mt-3 text-sm">{describeGithubHealth(model)}</p>
            {missingScopes.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {missingScopes.map((scope) => (
                  <li key={scope.scope} className="text-sm text-muted-foreground">
                    Missing scope: <span className="font-medium text-foreground">{scope.scope}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onStartGithubOAuth}
                disabled={model.github.isBusy}
                className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              >
                {model.github.health === "healthy" ? "Reconnect GitHub" : "Connect GitHub"}
              </button>
              <button
                type="button"
                onClick={() => onTestConnection("github")}
                disabled={model.github.isBusy || model.github.health === "missing"}
                className="inline-flex min-h-10 items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              >
                Test connection
              </button>
              <button
                type="button"
                onClick={onPushToGh}
                disabled={!model.github.canPushToGh || model.github.isBusy}
                title={model.github.canPushToGh ? undefined : "Connect GitHub first"}
                className="inline-flex min-h-10 items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              >
                Push token to local gh
              </button>
            </div>
          </section>
          <section aria-labelledby="settings-zen-heading" className="rounded-md border px-4 py-4">
            <h2 id="settings-zen-heading" className="text-lg font-semibold">Zen</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Zen has no OAuth, so the key stays pasted. It is stored write-only and never displayed after saving.
            </p>
            {model.zen.keySaved && (
              <p className="mt-3 text-sm text-muted-foreground">A Zen API key is saved. Tests use the saved key without displaying it.</p>
            )}
            <div className="mt-3 flex max-w-md flex-col gap-3">
              <div>
                <Label htmlFor="settings-zen-key">API key</Label>
                <Input
                  id="settings-zen-key"
                  type="password"
                  value={zenKey}
                  onChange={(event) => setZenKey(event.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  onSaveZenKey(zenKey)
                  setZenKey("")
                }}
                disabled={zenKey.length === 0 || model.zen.isBusy}
                className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              >
                Save Zen API key
              </button>
              <button
                type="button"
                onClick={() => onTestConnection("zen")}
                disabled={model.zen.isBusy || !model.zen.keySaved}
                className="inline-flex min-h-10 items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              >
                Test connection
              </button>
            </div>
          </section>
          <section aria-labelledby="settings-backend-heading" className="rounded-md border px-4 py-4">
            <h2 id="settings-backend-heading" className="text-lg font-semibold">Backend</h2>
            <p className="mt-2 text-sm text-muted-foreground">Active backend: {model.backendName}</p>
            <p className="mt-2 text-sm text-muted-foreground">Backend switching placement is deferred. This section reserves the seam.</p>
          </section>
        </div>
      )}
    </section>
  )
}

const describeGithubHealth = (model: ConnectionSettingsModel): string => {
  if (model.github.health === "healthy") {
    return model.github.accountName === null
      ? "Connected. GitHub is reachable and the credential was accepted."
      : `Connected as ${model.github.accountName}. GitHub is reachable and the credential was accepted.`
  }
  if (model.github.health === "missing") return "No GitHub connection saved yet. Connect below to set it up."
  if (model.github.health === "degraded") return "Connected with warnings. A scope check failed; the missing scope is named below."
  return "Connection state is unknown. Test the connection to refresh it."
}
