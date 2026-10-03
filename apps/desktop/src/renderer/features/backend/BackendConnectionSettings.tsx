import { Input } from "@expand/desktop/renderer/components/ui/input"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import type { BackendMode } from "@expand/desktop/renderer/features/backend/backend-connection-store"
import {
  describeRemoteProbe,
  formatRemoteFlag,
  type RemoteProbeView
} from "@expand/desktop/renderer/features/backend/remote-target"

export interface RemoteFormState {
  readonly host: string
  readonly portText: string
  readonly url: string
  readonly secure: boolean
  readonly token: string
}

export interface BackendConnectionSettingsProps {
  readonly mode: BackendMode
  readonly form: RemoteFormState
  readonly hasStoredToken: boolean
  readonly probe: RemoteProbeView | undefined
  readonly probeError: string | undefined
  readonly testing: boolean
  readonly onFormChange: (form: RemoteFormState) => void
  readonly onTestConnection: () => void
  readonly onSwitchMode: (mode: BackendMode) => void
}

export const BackendConnectionSettings = ({
  mode,
  form,
  hasStoredToken,
  probe,
  probeError,
  testing,
  onFormChange,
  onTestConnection,
  onSwitchMode
}: BackendConnectionSettingsProps) => {
  const set = (patch: Partial<RemoteFormState>) => onFormChange({ ...form, ...patch })
  return (
    <section aria-labelledby="backend-connection-heading">
      <h2 id="backend-connection-heading" className="text-lg font-semibold">Backend connection</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Run against the local backend, or connect to your own hosted backend. Switching never
        starts a local backend while remote mode is selected.
      </p>
      <div className="mt-3 flex gap-4" role="radiogroup" aria-label="Backend mode">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="backend-mode"
            aria-label="Local backend"
            checked={mode === "local"}
            onChange={() => onSwitchMode("local")}
          />
          Local backend
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="backend-mode"
            aria-label="Remote backend"
            checked={mode === "remote"}
            onChange={() => onSwitchMode("remote")}
          />
          Remote backend
        </label>
      </div>
      {mode === "remote" && (
        <>
          <div className="mt-3 flex max-w-md flex-col gap-3">
            <div>
              <Label htmlFor="remote-host">Host</Label>
              <Input
                id="remote-host"
                value={form.host}
                onChange={(event) => set({ host: event.target.value })}
                placeholder="backend.example"
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="remote-port">Port</Label>
              <Input
                id="remote-port"
                value={form.portText}
                onChange={(event) => set({ portText: event.target.value })}
                placeholder="43111"
                autoComplete="off"
                inputMode="numeric"
              />
            </div>
            <div>
              <Label htmlFor="remote-url">URL (optional override)</Label>
              <Input
                id="remote-url"
                value={form.url}
                onChange={(event) => set({ url: event.target.value })}
                placeholder="ws://backend.example:43111/rpc"
                autoComplete="off"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="Use TLS"
                checked={form.secure}
                onChange={(event) => set({ secure: event.target.checked })}
              />
              Use TLS (wss)
            </label>
            <div>
              <Label htmlFor="remote-token">Backend token</Label>
              <Input
                id="remote-token"
                type="password"
                value={form.token}
                onChange={(event) => set({ token: event.target.value })}
                autoComplete="new-password"
              />
              {hasStoredToken && (
                <p className="mt-1 text-sm text-muted-foreground">A token is saved for this backend.</p>
              )}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={onTestConnection} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </button>
          </div>
          {probeError !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{probeError}</p>
          )}
          {probe !== undefined && probe.reachable && probe.authenticated && (
            <div className="mt-2 text-sm">
              <p role="status">{describeRemoteProbe(probe)}</p>
              <p className="mt-1 text-muted-foreground">Reachable: {formatRemoteFlag(probe.reachable)}</p>
              <p className="text-muted-foreground">Authentication: {formatRemoteFlag(probe.authenticated)}</p>
            </div>
          )}
          {probe !== undefined && !(probe.reachable && probe.authenticated) && (
            <div className="mt-2 text-sm">
              <p role="alert" className="text-destructive">{describeRemoteProbe(probe)}</p>
              <p className="mt-1 text-muted-foreground">Reachable: {formatRemoteFlag(probe.reachable)}</p>
              <p className="text-muted-foreground">Authentication: {formatRemoteFlag(probe.authenticated)}</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
