import { useState } from "react"
import type { PersonalScope } from "@expand/contracts/automation"
import { Input } from "@expand/desktop/renderer/components/ui/input"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import {
  useCredentialStatuses,
  useGithubConnect,
  useGithubStatusCheck
} from "@expand/desktop/renderer/features/automations/data/use-integrations"
import {
  describeAutomationError,
  describeConnectionStatus,
  formatLabelsCount,
  formatStatusFlag,
  githubCredentialId
} from "@expand/desktop/renderer/features/automations/model/integration-messages"

export const GithubConnection = ({ scope }: { readonly scope: PersonalScope }) => {
  const credentials = useCredentialStatuses(scope)
  const connect = useGithubConnect(scope)
  const check = useGithubStatusCheck(scope)
  const [owner, setOwner] = useState("")
  const [repo, setRepo] = useState("")
  const [token, setToken] = useState("")
  const unavailable = credentials.unavailable || connect.unavailable || check.unavailable
  const tokenConfigured = credentials.credentials?.some(
    (credential) => credential.credentialId === githubCredentialId && credential.configured
  ) ?? false
  const canSave = !unavailable && !connect.isConnectPending &&
    owner.trim().length > 0 && repo.trim().length > 0 && token.length > 0

  const save = () => {
    connect.resetConnect()
    connect.connect({ owner: owner.trim(), repo: repo.trim(), token }, {
      onSuccess: () => {
        setToken("")
        credentials.retry()
      }
    })
  }

  const test = () => {
    check.resetStatus()
    check.check()
  }

  return (
    <section aria-labelledby="github-connection-heading">
      <h2 id="github-connection-heading" className="text-lg font-semibold">GitHub</h2>
      <p className="mt-2 text-sm text-muted-foreground">Save a token and repository so routines can label issues.</p>
      {unavailable ? (
        <p className="mt-2 text-sm text-muted-foreground">Automation services are unavailable in this session.</p>
      ) : (
        <>
          {tokenConfigured && (
            <p className="mt-2 text-sm text-muted-foreground">A GitHub token is saved for this project.</p>
          )}
          <div className="mt-3 flex max-w-md flex-col gap-3">
            <div>
              <Label htmlFor="github-owner">Repository owner</Label>
              <Input
                id="github-owner"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="octo"
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="github-repo">Repository name</Label>
              <Input
                id="github-repo"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="hello"
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="github-token">Personal access token</Label>
              <Input
                id="github-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={save} disabled={!canSave}>
              {connect.isConnectPending ? "Saving…" : "Save GitHub connection"}
            </button>
            <button type="button" onClick={test} disabled={unavailable || check.isStatusPending}>
              {check.isStatusPending ? "Testing…" : "Test connection"}
            </button>
          </div>
          {credentials.isLoading && (
            <p className="mt-2 text-sm text-muted-foreground">Loading saved credentials…</p>
          )}
          {credentials.error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(credentials.error)}</p>
          )}
          {connect.connectError !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(connect.connectError)}</p>
          )}
          {check.statusError !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(check.statusError)}</p>
          )}
          {check.status !== undefined && check.status.ok && (
            <div className="mt-2 text-sm">
              <p role="status">{describeConnectionStatus(check.status)}</p>
              <p className="mt-1 text-muted-foreground">Configured: {formatStatusFlag(check.status.configured)}</p>
              <p className="text-muted-foreground">Repository: {check.status.owner}/{check.status.repo}</p>
              <p className="text-muted-foreground">Labels: {formatLabelsCount(check.status.labels)}</p>
            </div>
          )}
          {check.status !== undefined && !check.status.ok && (
            <div className="mt-2 text-sm">
              <p role="alert" className="text-destructive">{describeConnectionStatus(check.status)}</p>
              <p className="mt-1 text-muted-foreground">Configured: {formatStatusFlag(check.status.configured)}</p>
              <p className="text-muted-foreground">Repository: {check.status.owner}/{check.status.repo}</p>
              <p className="text-muted-foreground">Labels: {formatLabelsCount(check.status.labels)}</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
